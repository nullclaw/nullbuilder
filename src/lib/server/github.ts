import {
  MAX_REPOSITORY_LIST_ENTRIES,
  normalizeRepoSlug,
  repoSlugParts,
  type RepoSlug
} from '../repositories';
import { readObjectRecord } from '../record-safety';
import type { NullbuilderConfig } from './config';
import { mapWithConcurrency, settleStarted } from './concurrency';
import {
  buildDashboard,
  GITHUB_WORK_ITEMS_PAGE_SIZE,
  makeErrorRepository,
  mapRepositorySummary,
  MAX_REPOSITORY_WORK_ITEM_PAGES_TO_SCAN,
  MAX_REPOSITORY_WORK_ITEMS_TO_SCAN,
  type DashboardData,
  type GitHubIssueResponse,
  type GitHubPullResponse,
  type GitHubRepositoryResponse,
  type RepositorySummary
} from './github-dashboard';
import { githubGetPages, githubRequest } from './github-client';
import { getStarGrowth } from './github-star-growth';

export { GitHubApiError, githubGet, githubGetPages, publicErrorMessage, resolveGitHubApiUrl } from './github-client';
export { assertConfiguredRepository, buildPrTag, createReleaseTag } from './github-mutations';
export type { BuildPrResult, ReleaseTagResult } from './github-mutations';
export type {
  DashboardData,
  GitHubLabel,
  IssueSummary,
  PullRequestSummary,
  RepositorySummary,
  StarGrowthSummary,
  WorkflowRunSummary
} from './github-dashboard';

export async function getDashboard(config: NullbuilderConfig): Promise<DashboardData> {
  const repoList = config.discoverRepos ? await discoverRepositories(config) : config.repos;
  const repositories = await mapWithConcurrency(repoList, config.concurrency, (repo) =>
    getRepositorySummary(config, repo)
  );
  return buildDashboard(config, repoList, repositories);
}

export async function discoverRepositories(config: NullbuilderConfig): Promise<RepoSlug[]> {
  type RepositoryListItem = {
    name: string;
    full_name: string;
    language: string | null;
    archived: boolean;
  };

  const configured = repositorySlugMap(config.repos);
  const ignored = repositoryKeySet(config.ignoredRepos);

  try {
    const repos = await githubGetPages<RepositoryListItem>(
      config,
      `/users/${config.owner}/repos?type=owner&sort=updated&per_page=100`,
      {},
      20,
      MAX_REPOSITORY_LIST_ENTRIES
    );

    for (const repo of repos) {
      const discoveredRepo = safeDiscoveredRepository(repo);
      if (!discoveredRepo) {
        continue;
      }

      const slug = normalizeDiscoveredRepoSlug(discoveredRepo.full_name, config.owner);
      if (!slug) {
        continue;
      }

      const key = repoKey(slug);
      if (ignored.has(key)) {
        continue;
      }

      const name = repoName(slug);
      const isNullRepo = name.startsWith('null') || name === 'nllclw';
      const isZigRepo = discoveredRepo.language === 'Zig';
      if (!discoveredRepo.archived && (isNullRepo || isZigRepo) && !configured.has(key)) {
        if (configured.size >= MAX_REPOSITORY_LIST_ENTRIES) {
          break;
        }
        configured.set(key, slug);
      }
    }
  } catch {
    return config.repos;
  }

  return [...configured.values()].sort((left, right) => left.localeCompare(right));
}

function safeDiscoveredRepository(value: unknown): {
  name: string;
  full_name: string;
  language: string | null;
  archived: boolean;
} | null {
  const repo = readObjectRecord(value);
  if (!repo) {
    return null;
  }

  if (typeof repo.name !== 'string' || typeof repo.full_name !== 'string') {
    return null;
  }

  return {
    name: repo.name,
    full_name: repo.full_name,
    language: typeof repo.language === 'string' ? repo.language : null,
    archived: repo.archived === true
  };
}

function normalizeDiscoveredRepoSlug(fullName: string, defaultOwner: string): RepoSlug | null {
  try {
    return normalizeRepoSlug(fullName, defaultOwner);
  } catch {
    return null;
  }
}

function repositorySlugMap(repos: readonly RepoSlug[]): Map<string, RepoSlug> {
  const slugs = new Map<string, RepoSlug>();

  for (const repo of repos) {
    const key = repoKey(repo);
    if (!slugs.has(key)) {
      slugs.set(key, repo);
    }
  }

  return slugs;
}

function repositoryKeySet(repos: readonly RepoSlug[]): Set<string> {
  const keys = new Set<string>();

  for (const repo of repos) {
    keys.add(repoKey(repo));
  }

  return keys;
}

function repoKey(repo: RepoSlug): string {
  return repo.toLowerCase();
}

function repoName(repo: RepoSlug): string {
  return repoSlugParts(repo).name.toLowerCase();
}

export async function getRepositorySummary(config: NullbuilderConfig, repo: RepoSlug): Promise<RepositorySummary> {
  try {
    const repository = await githubRequest<GitHubRepositoryResponse>(config, `/repos/${repo}`);
    const [issues, pulls, runs, starGrowth] = await settleStarted([
      githubGetPages<GitHubIssueResponse>(
        config,
        `/repos/${repo}/issues?state=open&per_page=${GITHUB_WORK_ITEMS_PAGE_SIZE}`,
        {},
        MAX_REPOSITORY_WORK_ITEM_PAGES_TO_SCAN,
        MAX_REPOSITORY_WORK_ITEMS_TO_SCAN
      ),
      githubGetPages<GitHubPullResponse>(
        config,
        `/repos/${repo}/pulls?state=open&per_page=${GITHUB_WORK_ITEMS_PAGE_SIZE}`,
        {},
        MAX_REPOSITORY_WORK_ITEM_PAGES_TO_SCAN,
        MAX_REPOSITORY_WORK_ITEMS_TO_SCAN
      ),
      githubRequest<unknown>(config, `/repos/${repo}/actions/runs?per_page=100`),
      getStarGrowth(config, repo, repository.stargazers_count)
    ] as const);

    return mapRepositorySummary(repo, repository, issues, pulls, safeWorkflowRunsPayload(runs), starGrowth, config.webBaseUrl);
  } catch (error) {
    return makeErrorRepository(config, repo, error);
  }
}

function safeWorkflowRunsPayload(value: unknown): unknown[] {
  const payload = readObjectRecord(value);
  if (!payload) {
    return [];
  }

  const workflowRuns = payload.workflow_runs;
  return Array.isArray(workflowRuns) ? workflowRuns : [];
}
