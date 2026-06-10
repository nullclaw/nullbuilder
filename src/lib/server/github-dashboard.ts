import { safeUtcTimestampText } from '../date-safety';
import type { RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { publicErrorMessage } from './github-client';
import type { DashboardData, IssueSummary, PullRequestSummary, RepositorySummary } from './github-dashboard-types';
import { githubRepositoryWebUrl } from './github-web-urls';
import { MAX_TIMESTAMP_TEXT_LENGTH } from './github-dashboard-mappers';
import { saturatingSafeIntegerAdd } from './number-safety';
import {
  compareByUpdatedAtDesc,
  hasValidRecentWorkItemLimit,
  RecentWorkItemCollector,
  type WorkItemWithUpdatedAt
} from './recent-work-items';

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
    generatedAt: safeDashboardTimestamp(generatedAt),
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
  if (!hasValidRecentWorkItemLimit(maxItems)) {
    return [];
  }

  const collector = new RecentWorkItemCollector<T>(maxItems);

  for (const repo of repositories) {
    for (const item of itemsForRepository(repo)) {
      collector.add(item);
    }
  }

  return collector.items();
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
    updatedAt: safeDashboardTimestamp(updatedAt),
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

function safeDashboardTimestamp(value: string): string {
  return safeUtcTimestampText(value, { maxLength: MAX_TIMESTAMP_TEXT_LENGTH });
}

export function sortByUpdatedAt(left: WorkItemWithUpdatedAt, right: WorkItemWithUpdatedAt): number {
  return compareByUpdatedAtDesc(left, right);
}

function repositoryHasFailingRun(repo: RepositorySummary): boolean {
  const runs = Object.values(repo.latestRuns);
  return runs.some((run) => run?.status === 'completed' && run.conclusion !== 'success');
}
