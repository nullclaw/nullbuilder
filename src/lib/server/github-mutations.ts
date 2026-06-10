import { findConfiguredRepoSlug, normalizeRepoSlug, type RepoSlug } from '../repositories';
import { readObjectRecord } from '../record-safety';
import { sanitizeText } from '../text-safety';
import type { NullbuilderConfig } from './config';
import { settleStarted } from './concurrency';
import {
  assertFullGitSha,
  isFullGitSha,
  sanitizeGitBranchName,
  sanitizeGitTargetRef
} from './git-refs';
import { GitHubApiError, githubRequest } from './github-client';
import { encodeGitHubPathSegment } from './github-url-encoding';
import {
  githubActionsBranchQueryUrl,
  githubReleaseTagUrl,
  githubRepositoryUrlContext
} from './github-web-urls';
import {
  BUILD_PR_TAG_PREFIX,
  defaultBuildPrTagName,
  sanitizeBuildPrTagName,
  sanitizeReleaseTagName
} from './tags';
import { isSafePositiveInteger } from '../number-safety';

export type BuildPrResult = {
  repo: RepoSlug;
  prNumber: number;
  prTitle: string;
  headSha: string;
  headBranch: string;
  tagName: string;
  tagUrl: string;
  workflowUrl: string;
  workflowTagPattern: string;
  dryRun: boolean;
  created: boolean;
  forced: boolean;
};

export type ReleaseTagResult = {
  repo: RepoSlug;
  tagName: string;
  targetRef: string;
  targetSha: string;
  tagUrl: string;
  workflowUrl: string;
  workflowTagPattern: string;
  dryRun: boolean;
  created: boolean;
  forced: boolean;
};

type GitHubRepositoryResponse = {
  default_branch: string;
};

type GitHubPullDetailResponse = unknown;

type GitHubBranchResponse = {
  commit: {
    sha: string;
  };
};

const MAX_PULL_TITLE_LENGTH = 1024;
const MAX_HEAD_BRANCH_LENGTH = 255;

export async function buildPrTag(
  config: NullbuilderConfig,
  options: {
    repo: string;
    prNumber: number;
    tagName?: string;
    confirm?: boolean;
    force?: boolean;
    allowDraft?: boolean;
    allowFork?: boolean;
    allowNonDefaultBase?: boolean;
  }
): Promise<BuildPrResult> {
  const confirm = optionEnabled(options.confirm);
  const force = optionEnabled(options.force);
  const prNumber = assertPositivePrNumber(options.prNumber);
  const repo = assertConfiguredRepository(config, normalizeRepoSlug(options.repo, config.owner));
  const requestedTagName = options.tagName ? sanitizeBuildPrTagName(options.tagName) : undefined;
  const [repository, pull] = await settleStarted([
    githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`, {
      useCache: false
    }),
    githubRequest<GitHubPullDetailResponse>(config, `/repos/${repo}/pulls/${prNumber}`, {
      useCache: false
    })
  ] as const);
  const defaultBranch = sanitizeGitBranchName(repository.default_branch, 'default branch');
  assertTrustedPullRequest(repo, defaultBranch, pull, options);
  const headSha = assertFullGitSha(pullHeadSha(pull), 'pull request head SHA');
  const tagName = requestedTagName ?? sanitizeBuildPrTagName(defaultBuildPrTagName(prNumber, headSha));
  const urlContext = githubRepositoryUrlContext(config.webBaseUrl, repo);
  const tagUrl = githubReleaseTagUrl(urlContext, tagName);
  const workflowUrl = githubActionsBranchQueryUrl(urlContext, tagName);

  const result: BuildPrResult = {
    repo,
    prNumber,
    prTitle: sanitizeResultText(pullField(pull, 'title'), MAX_PULL_TITLE_LENGTH, 'Untitled PR'),
    headSha,
    headBranch: sanitizeResultText(pullHeadRef(pull), MAX_HEAD_BRANCH_LENGTH, 'unknown'),
    tagName,
    tagUrl,
    workflowUrl,
    workflowTagPattern: `${BUILD_PR_TAG_PREFIX}*`,
    dryRun: !confirm,
    created: false,
    forced: false
  };

  if (!confirm) {
    return result;
  }

  const tagState = await createOrMoveTagRef(config, repo, tagName, headSha, force);

  return {
    ...result,
    dryRun: false,
    created: tagState.created,
    forced: tagState.forced
  };
}

export async function createReleaseTag(
  config: NullbuilderConfig,
  options: {
    repo: string;
    tagName: string;
    targetRef?: string;
    confirm?: boolean;
    force?: boolean;
  }
): Promise<ReleaseTagResult> {
  const confirm = optionEnabled(options.confirm);
  const force = optionEnabled(options.force);
  const repo = assertConfiguredRepository(config, normalizeRepoSlug(options.repo, config.owner));
  const tagName = sanitizeReleaseTagName(options.tagName);
  const requestedTargetRef = options.targetRef?.trim();
  const targetRefOverride = requestedTargetRef ? sanitizeGitTargetRef(requestedTargetRef) : undefined;
  const repository = await githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`, {
    useCache: false
  });
  const targetRef = targetRefOverride ?? sanitizeGitBranchName(repository.default_branch, 'default branch');
  const targetSha = await resolveTargetSha(config, repo, targetRef);
  const urlContext = githubRepositoryUrlContext(config.webBaseUrl, repo);
  const tagUrl = githubReleaseTagUrl(urlContext, tagName);
  const workflowUrl = githubActionsBranchQueryUrl(urlContext, tagName);

  const result: ReleaseTagResult = {
    repo,
    tagName,
    targetRef,
    targetSha,
    tagUrl,
    workflowUrl,
    workflowTagPattern: 'v*',
    dryRun: !confirm,
    created: false,
    forced: false
  };

  if (!confirm) {
    return result;
  }

  const tagState = await createOrMoveTagRef(config, repo, tagName, targetSha, force);

  return {
    ...result,
    dryRun: false,
    created: tagState.created,
    forced: tagState.forced
  };
}

export function assertConfiguredRepository(config: NullbuilderConfig, repo: RepoSlug): RepoSlug {
  const configuredRepo = findConfiguredRepoSlug(config.repos, repo, config.owner);
  if (!configuredRepo) {
    throw new Error(`Repository ${repo} is not in NULLBUILDER_REPOS.`);
  }

  return configuredRepo;
}

function assertTrustedPullRequest(
  repo: RepoSlug,
  defaultBranch: string,
  pull: GitHubPullDetailResponse,
  options: {
    allowDraft?: boolean;
    allowFork?: boolean;
    allowNonDefaultBase?: boolean;
  }
): void {
  const reasons: string[] = [];
  const headRepo = pullHeadRepositorySlug(pull);

  if (pullDraft(pull) !== false && !optionEnabled(options.allowDraft)) {
    reasons[reasons.length] = 'draft PRs are rejected by default';
  }

  if (pullBaseRef(pull) !== defaultBranch && !optionEnabled(options.allowNonDefaultBase)) {
    reasons[reasons.length] = `base branch must be ${defaultBranch}`;
  }

  if ((headRepo === null || headRepo.toLowerCase() !== repo.toLowerCase()) && !optionEnabled(options.allowFork)) {
    reasons[reasons.length] = 'fork PRs are rejected by default';
  }

  if (reasons.length > 0) {
    throw new Error(`Pull request is not trusted: ${reasons.join('; ')}.`);
  }
}

function pullField(pull: GitHubPullDetailResponse, field: string): unknown {
  return readObjectRecord(pull)?.[field];
}

function pullBaseRef(pull: GitHubPullDetailResponse): string {
  const value = readObjectRecord(pullField(pull, 'base'))?.ref;
  return typeof value === 'string' ? value : '';
}

function pullDraft(pull: GitHubPullDetailResponse): boolean | null {
  const value = pullField(pull, 'draft');
  return typeof value === 'boolean' ? value : null;
}

function pullHeadObject(pull: GitHubPullDetailResponse): Record<string, unknown> | null {
  return readObjectRecord(pullField(pull, 'head'));
}

function pullHeadRef(pull: GitHubPullDetailResponse): unknown {
  return pullHeadObject(pull)?.ref;
}

function pullHeadSha(pull: GitHubPullDetailResponse): unknown {
  return pullHeadObject(pull)?.sha;
}

function pullHeadRepositorySlug(pull: GitHubPullDetailResponse): RepoSlug | null {
  const repo = readObjectRecord(pullHeadObject(pull)?.repo);
  const value = repo?.full_name;
  if (typeof value !== 'string' || !value.includes('/')) {
    return null;
  }

  try {
    return normalizeRepoSlug(value);
  } catch {
    return null;
  }
}

async function resolveTargetSha(config: NullbuilderConfig, repo: RepoSlug, targetRef: string): Promise<string> {
  if (isFullGitSha(targetRef)) {
    return assertFullGitSha(targetRef, 'target SHA');
  }

  const branchRef = sanitizeGitBranchName(targetRef, 'target ref');
  const branch = await githubRequest<GitHubBranchResponse>(
    config,
    `/repos/${repo}/branches/${encodeGitHubPathSegment(branchRef)}`,
    {
      useCache: false
    }
  );

  return assertFullGitSha(branch.commit.sha, 'branch commit SHA');
}

async function createOrMoveTagRef(
  config: NullbuilderConfig,
  repo: RepoSlug,
  tagName: string,
  sha: string,
  force: boolean
): Promise<{ created: boolean; forced: boolean }> {
  const targetSha = assertFullGitSha(sha, 'tag target SHA');

  try {
    await githubRequest<unknown>(config, `/repos/${repo}/git/refs`, {
      useCache: false,
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/tags/${tagName}`,
        sha: targetSha
      })
    });
    return {
      created: true,
      forced: false
    };
  } catch (error) {
    if (!force || !isValidationError(error)) {
      throw error;
    }

    await githubRequest<unknown>(config, `/repos/${repo}/git/ref/tags/${tagName}`, {
      useCache: false
    });
    await githubRequest<unknown>(config, `/repos/${repo}/git/refs/tags/${tagName}`, {
      useCache: false,
      method: 'PATCH',
      body: JSON.stringify({
        sha: targetSha,
        force: true
      })
    });

    return {
      created: false,
      forced: true
    };
  }
}

function isValidationError(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 422;
}

function assertPositivePrNumber(value: number): number {
  if (!isSafePositiveInteger(value)) {
    throw new Error('Invalid pull request number.');
  }

  return value;
}

function optionEnabled(value: unknown): boolean {
  return value === true;
}

function sanitizeResultText(value: unknown, maxLength: number, fallback: string): string {
  return sanitizeText(typeof value === 'string' ? value : '', {
    maxLength,
    fallback,
    trim: true
  });
}
