import { normalizeRepoSlug, type RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { GitHubApiError, githubRequest } from './github-client';
import {
  BUILD_PR_TAG_PREFIX,
  defaultBuildPrTagName,
  sanitizeBuildPrTagName,
  sanitizeReleaseTagName
} from './tags';

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

type GitHubPullDetailResponse = {
  number: number;
  title: string;
  draft: boolean;
  base: {
    ref: string;
  };
  head: {
    ref: string;
    sha: string;
    repo?: {
      full_name: string;
    } | null;
  };
};

type GitHubBranchResponse = {
  commit: {
    sha: string;
  };
};

const FULL_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_TARGET_REF_LENGTH = 255;
const UNSAFE_TARGET_REF_PATTERN = /[\u0000-\u001f\u007f ~^:?*[\]\\]/;

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
  const repo = assertConfiguredRepository(config, normalizeRepoSlug(options.repo, config.owner));
  const requestedTagName = options.tagName ? sanitizeBuildPrTagName(options.tagName) : undefined;
  const [repository, pull] = await Promise.all([
    githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`, {
      useCache: false
    }),
    githubRequest<GitHubPullDetailResponse>(config, `/repos/${repo}/pulls/${options.prNumber}`, {
      useCache: false
    })
  ]);
  assertTrustedPullRequest(repo, repository.default_branch, pull, options);
  const tagName = requestedTagName ?? sanitizeBuildPrTagName(defaultBuildPrTagName(options.prNumber, pull.head.sha));
  const tagUrl = `${config.webBaseUrl}/${repo}/releases/tag/${tagName}`;
  const workflowUrl = `${config.webBaseUrl}/${repo}/actions?query=${encodeURIComponent(`branch:${tagName}`)}`;

  const result: BuildPrResult = {
    repo,
    prNumber: pull.number,
    prTitle: pull.title,
    headSha: pull.head.sha,
    headBranch: pull.head.ref,
    tagName,
    tagUrl,
    workflowUrl,
    workflowTagPattern: `${BUILD_PR_TAG_PREFIX}*`,
    dryRun: !options.confirm,
    created: false,
    forced: false
  };

  if (!options.confirm) {
    return result;
  }

  const tagState = await createOrMoveTagRef(config, repo, tagName, pull.head.sha, Boolean(options.force));

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
  const repo = assertConfiguredRepository(config, normalizeRepoSlug(options.repo, config.owner));
  const tagName = sanitizeReleaseTagName(options.tagName);
  const requestedTargetRef = options.targetRef?.trim();
  const targetRefOverride = requestedTargetRef ? sanitizeReleaseTargetRef(requestedTargetRef) : undefined;
  const repository = await githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`, {
    useCache: false
  });
  const targetRef = targetRefOverride ?? sanitizeReleaseTargetRef(repository.default_branch);
  const targetSha = await resolveTargetSha(config, repo, targetRef);
  const tagUrl = `${config.webBaseUrl}/${repo}/releases/tag/${tagName}`;
  const workflowUrl = `${config.webBaseUrl}/${repo}/actions?query=${encodeURIComponent(`branch:${tagName}`)}`;

  const result: ReleaseTagResult = {
    repo,
    tagName,
    targetRef,
    targetSha,
    tagUrl,
    workflowUrl,
    workflowTagPattern: 'v*',
    dryRun: !options.confirm,
    created: false,
    forced: false
  };

  if (!options.confirm) {
    return result;
  }

  const tagState = await createOrMoveTagRef(config, repo, tagName, targetSha, Boolean(options.force));

  return {
    ...result,
    dryRun: false,
    created: tagState.created,
    forced: tagState.forced
  };
}

export function assertConfiguredRepository(config: NullbuilderConfig, repo: RepoSlug): RepoSlug {
  const allowed = new Set(config.repos.map((entry) => entry.toLowerCase()));
  if (!allowed.has(repo.toLowerCase())) {
    throw new Error(`Repository ${repo} is not in NULLBUILDER_REPOS.`);
  }

  return repo;
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
  const headRepo = pull.head.repo?.full_name;

  if (pull.draft && !options.allowDraft) {
    reasons.push('draft PRs are rejected by default');
  }

  if (pull.base.ref !== defaultBranch && !options.allowNonDefaultBase) {
    reasons.push(`base branch must be ${defaultBranch}`);
  }

  if ((!headRepo || headRepo.toLowerCase() !== repo.toLowerCase()) && !options.allowFork) {
    reasons.push('fork PRs are rejected by default');
  }

  if (reasons.length > 0) {
    throw new Error(`Pull request is not trusted: ${reasons.join('; ')}.`);
  }
}

async function resolveTargetSha(config: NullbuilderConfig, repo: RepoSlug, targetRef: string): Promise<string> {
  if (FULL_SHA_PATTERN.test(targetRef)) {
    return targetRef;
  }

  const branch = await githubRequest<GitHubBranchResponse>(
    config,
    `/repos/${repo}/branches/${encodeURIComponent(targetRef)}`,
    {
      useCache: false
    }
  );

  return branch.commit.sha;
}

function sanitizeReleaseTargetRef(value: string): string {
  const targetRef = value.trim();

  if (!isSafeReleaseTargetRef(targetRef)) {
    throw new Error(`Invalid target ref: ${value}`);
  }

  return targetRef;
}

function isSafeReleaseTargetRef(targetRef: string): boolean {
  if (!targetRef || targetRef.length > MAX_TARGET_REF_LENGTH) {
    return false;
  }

  if (FULL_SHA_PATTERN.test(targetRef)) {
    return true;
  }

  if (
    targetRef.startsWith('refs/') ||
    targetRef.startsWith('/') ||
    targetRef.endsWith('/') ||
    targetRef.endsWith('.') ||
    targetRef.endsWith('.lock') ||
    targetRef.includes('//') ||
    targetRef.includes('..') ||
    targetRef.includes('@{') ||
    UNSAFE_TARGET_REF_PATTERN.test(targetRef)
  ) {
    return false;
  }

  return targetRef.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

async function createOrMoveTagRef(
  config: NullbuilderConfig,
  repo: RepoSlug,
  tagName: string,
  sha: string,
  force: boolean
): Promise<{ created: boolean; forced: boolean }> {
  try {
    await githubRequest<unknown>(config, `/repos/${repo}/git/refs`, {
      useCache: false,
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/tags/${tagName}`,
        sha
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
        sha,
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
