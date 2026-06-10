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

type RepositorySlugCollection = {
  keys: Set<string>;
  values: RepoSlug[];
};

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

  const configured = repositorySlugCollection(config.repos);
  const ignored = repositoryKeySet(config.ignoredRepos);

  try {
    const repos = await githubGetPages<RepositoryListItem>(
      config,
      `/users/${config.owner}/repos?type=owner&sort=updated&per_page=100`,
      {},
      20,
      MAX_REPOSITORY_LIST_ENTRIES
    );

    for (let index = 0; index < repos.length; index += 1) {
      const discoveredRepo = safeDiscoveredRepository(repos[index]);
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
      if (!discoveredRepo.archived && (isNullRepo || isZigRepo) && !configured.keys.has(key)) {
        if (configured.values.length >= MAX_REPOSITORY_LIST_ENTRIES) {
          break;
        }
        configured.keys.add(key);
        configured.values.push(slug);
      }
    }
  } catch {
    return copyRepositorySlugs(config.repos);
  }

  return sortedRepositoryValues(configured.values);
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

function repositorySlugCollection(repos: readonly RepoSlug[]): RepositorySlugCollection {
  const collection: RepositorySlugCollection = {
    keys: new Set<string>(),
    values: []
  };

  for (let index = 0; index < repos.length; index += 1) {
    const repo = repos[index];
    const key = repoKey(repo);
    if (!collection.keys.has(key)) {
      collection.keys.add(key);
      collection.values.push(repo);
    }
  }

  return collection;
}

function repositoryKeySet(repos: readonly RepoSlug[]): Set<string> {
  const keys = new Set<string>();

  for (let index = 0; index < repos.length; index += 1) {
    keys.add(repoKey(repos[index]));
  }

  return keys;
}

function sortedRepositoryValues(repositories: readonly RepoSlug[]): RepoSlug[] {
  const values = copyRepositorySlugs(repositories);
  sortRepositorySlugs(values);
  return values;
}

function sortRepositorySlugs(values: RepoSlug[]): void {
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    let insertionIndex = index;
    while (insertionIndex > 0 && values[insertionIndex - 1].localeCompare(value) > 0) {
      values[insertionIndex] = values[insertionIndex - 1];
      insertionIndex -= 1;
    }
    values[insertionIndex] = value;
  }
}

function copyRepositorySlugs(repos: readonly RepoSlug[]): RepoSlug[] {
  const copy: RepoSlug[] = [];
  for (let index = 0; index < repos.length; index += 1) {
    copy.push(repos[index]);
  }
  return copy;
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
