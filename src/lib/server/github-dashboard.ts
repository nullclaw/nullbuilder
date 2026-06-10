import type { RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { publicErrorMessage } from './github-client';
import type { DashboardData, IssueSummary, PullRequestSummary, RepositorySummary } from './github-dashboard-types';
import { githubRepositoryWebUrl } from './github-web-urls';

export const MAX_DASHBOARD_WORK_LIST_ITEMS = 500;

export {
  mapLatestRuns,
  mapRepositorySummary,
  MAX_DASHBOARD_TEXT_FIELD_LENGTH,
  MAX_DASHBOARD_URL_LENGTH,
  MAX_LABELS_PER_WORK_ITEM,
  MAX_LABEL_NAME_LENGTH,
  MAX_TIMESTAMP_TEXT_LENGTH,
  MAX_WORK_ITEM_TITLE_LENGTH,
  MAX_REPOSITORY_WORK_ITEMS
} from './github-dashboard-mappers';
export type {
  DashboardData,
  GitHubIssueResponse,
  GitHubLabel,
  GitHubPullResponse,
  GitHubRepositoryResponse,
  GitHubWorkflowRunResponse,
  IssueSummary,
  PullRequestSummary,
  RepositorySummary,
  StarGrowthSummary,
  WorkflowRunSummary
} from './github-dashboard-types';

export function buildDashboard(
  config: NullbuilderConfig,
  repoList: RepoSlug[],
  repositories: RepositorySummary[],
  generatedAt = new Date().toISOString()
): DashboardData {
  const loadedRepositories = repositories.filter((repo) => repo.status === 'ok');
  const issues = collectRecentWorkItems(loadedRepositories, (repo) => repo.issues);
  const pullRequests = collectRecentWorkItems(loadedRepositories, (repo) => repo.pullRequests);
  const failingRuns = loadedRepositories.filter(repositoryHasFailingRun).length;
  const erroredRepositories = repositories.length - loadedRepositories.length;
  const issueCount = countWorkItems(loadedRepositories, (repo) => repo.openIssues ?? repo.issues.length);
  const pullRequestCount = countWorkItems(
    loadedRepositories,
    (repo) => repo.openPulls ?? repo.pullRequests.length
  );

  return {
    generatedAt,
    hasToken: Boolean(config.token),
    owner: config.owner,
    repos: repoList,
    repositories,
    issues,
    pullRequests,
    hasReadErrors: erroredRepositories > 0,
    totals: {
      repositories: repositories.length,
      loadedRepositories: loadedRepositories.length,
      erroredRepositories,
      issues: issueCount,
      pullRequests: pullRequestCount,
      stars: loadedRepositories.reduce((total, repo) => saturatingSafeIntegerAdd(total, repo.stars ?? 0), 0),
      failingRuns
    }
  };
}

function collectRecentWorkItems<T extends IssueSummary | PullRequestSummary>(
  repositories: RepositorySummary[],
  itemsForRepository: (repo: RepositorySummary) => T[],
  maxItems = MAX_DASHBOARD_WORK_LIST_ITEMS
): T[] {
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0) {
    return [];
  }

  const rankedItems: RankedWorkItem<T>[] = [];
  let ordinal = 0;

  for (const repo of repositories) {
    for (const item of itemsForRepository(repo)) {
      insertRecentWorkItem(
        rankedItems,
        {
          item,
          timestamp: updatedAtTimestamp(item.updatedAt),
          ordinal
        },
        maxItems
      );
      ordinal += 1;
    }
  }

  return rankedItems.map(({ item }) => item);
}

type RankedWorkItem<T extends IssueSummary | PullRequestSummary> = {
  item: T;
  timestamp: number;
  ordinal: number;
};

function insertRecentWorkItem<T extends IssueSummary | PullRequestSummary>(
  items: RankedWorkItem<T>[],
  item: RankedWorkItem<T>,
  maxItems: number
): void {
  if (items.length >= maxItems && compareRecentWorkItems(item, items[items.length - 1]) >= 0) {
    return;
  }

  let lower = 0;
  let upper = items.length;

  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (compareRecentWorkItems(item, items[middle]) < 0) {
      upper = middle;
    } else {
      lower = middle + 1;
    }
  }

  items.splice(lower, 0, item);
  if (items.length > maxItems) {
    items.length = maxItems;
  }
}

function compareRecentWorkItems<T extends IssueSummary | PullRequestSummary>(
  left: RankedWorkItem<T>,
  right: RankedWorkItem<T>
): number {
  const timestampOrder = right.timestamp - left.timestamp;
  return timestampOrder === 0 ? left.ordinal - right.ordinal : timestampOrder;
}

function countWorkItems(
  repositories: RepositorySummary[],
  countForRepository: (repo: RepositorySummary) => number
): number {
  return repositories.reduce((total, repo) => saturatingSafeIntegerAdd(total, countForRepository(repo)), 0);
}

export function makeErrorRepository(
  config: NullbuilderConfig,
  repo: RepoSlug,
  error: unknown,
  updatedAt = new Date().toISOString()
): RepositorySummary {
  const [owner, name] = repo.split('/');

  return {
    slug: repo,
    owner,
    name,
    fullName: repo,
    url: githubRepositoryWebUrl(config.webBaseUrl, repo),
    description: '',
    defaultBranch: 'unknown',
    language: null,
    isPrivate: false,
    archived: false,
    stars: null,
    forks: null,
    openIssues: null,
    openPulls: null,
    pushedAt: null,
    updatedAt,
    issues: [],
    pullRequests: [],
    starGrowth: {
      current: null,
      last7Days: null,
      last30Days: null
    },
    latestRuns: {
      ci: null,
      nightly: null,
      release: null
    },
    status: 'error',
    error: publicErrorMessage(error)
  };
}

export function sortByUpdatedAt(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return updatedAtTimestamp(right.updatedAt) - updatedAtTimestamp(left.updatedAt);
}

function repositoryHasFailingRun(repo: RepositorySummary): boolean {
  const runs = Object.values(repo.latestRuns);
  return runs.some((run) => run?.status === 'completed' && run.conclusion !== 'success');
}

function updatedAtTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function saturatingSafeIntegerAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0) {
    return left;
  }

  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
