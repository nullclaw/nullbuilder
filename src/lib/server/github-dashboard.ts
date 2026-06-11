import { safeUtcTimestampText } from '../date-safety';
import { repoSlugParts, type RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { publicErrorMessage } from './github-client';
import type { DashboardData, IssueSummary, PullRequestSummary, RepositorySummary } from './github-dashboard-types';
import { githubRepositoryWebUrl } from './github-web-urls';
import { MAX_TIMESTAMP_TEXT_LENGTH } from './github-dashboard-mappers';
import { saturatingSafeIntegerAdd } from '../number-safety';
import { isFailingWorkflowRun } from '../workflow-run-labels';
import {
  compareByUpdatedAtDesc,
  RecentWorkItemCollector,
  type WorkItemWithUpdatedAt
} from './recent-work-items';

export const MAX_DASHBOARD_WORK_LIST_ITEMS = 500;

export {
  GITHUB_WORK_ITEMS_PAGE_SIZE,
  mapLatestRuns,
  mapRepositorySummary,
  workflowRunClassifierEntries,
  MAX_DASHBOARD_TEXT_FIELD_LENGTH,
  MAX_DASHBOARD_URL_LENGTH,
  MAX_LABELS_PER_WORK_ITEM,
  MAX_LABELS_TO_SCAN,
  MAX_LABEL_NAME_LENGTH,
  MAX_REPOSITORY_WORK_ITEM_PAGES_TO_SCAN,
  MAX_REPOSITORY_WORK_ITEMS_TO_SCAN,
  MAX_TIMESTAMP_TEXT_LENGTH,
  MAX_WORK_ITEM_TITLE_LENGTH,
  MAX_WORKFLOW_RUNS_PER_REPOSITORY,
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
  const summary = summarizeRepositories(repositories);

  return {
    generatedAt: safeDashboardTimestamp(generatedAt),
    hasToken: Boolean(config.token),
    owner: config.owner,
    repos: repoList,
    repositories,
    issues: summary.issues,
    pullRequests: summary.pullRequests,
    hasReadErrors: summary.erroredRepositories > 0,
    totals: {
      repositories: repositories.length,
      loadedRepositories: summary.loadedRepositories,
      erroredRepositories: summary.erroredRepositories,
      issues: summary.issueCount,
      pullRequests: summary.pullRequestCount,
      stars: summary.starCount,
      failingRuns: summary.failingRuns
    }
  };
}

type DashboardRepositorySummary = {
  issues: IssueSummary[];
  pullRequests: PullRequestSummary[];
  loadedRepositories: number;
  erroredRepositories: number;
  issueCount: number;
  pullRequestCount: number;
  starCount: number;
  failingRuns: number;
};

function summarizeRepositories(repositories: RepositorySummary[]): DashboardRepositorySummary {
  const issues = new RecentWorkItemCollector<IssueSummary>(MAX_DASHBOARD_WORK_LIST_ITEMS);
  const pullRequests = new RecentWorkItemCollector<PullRequestSummary>(MAX_DASHBOARD_WORK_LIST_ITEMS);
  let loadedRepositories = 0;
  let issueCount = 0;
  let pullRequestCount = 0;
  let starCount = 0;
  let failingRuns = 0;

  for (let repoIndex = 0; repoIndex < repositories.length; repoIndex += 1) {
    const repo = repositories[repoIndex];
    if (!repo) {
      continue;
    }
    if (repo.status !== 'ok') {
      continue;
    }

    loadedRepositories += 1;
    issueCount = saturatingSafeIntegerAdd(issueCount, repo.openIssues ?? repo.issues.length);
    pullRequestCount = saturatingSafeIntegerAdd(
      pullRequestCount,
      repo.openPulls ?? repo.pullRequests.length
    );
    starCount = saturatingSafeIntegerAdd(starCount, repo.stars ?? 0);

    if (repositoryHasFailingRun(repo)) {
      failingRuns += 1;
    }

    for (let issueIndex = 0; issueIndex < repo.issues.length; issueIndex += 1) {
      issues.add(repo.issues[issueIndex]);
    }
    for (let pullRequestIndex = 0; pullRequestIndex < repo.pullRequests.length; pullRequestIndex += 1) {
      pullRequests.add(repo.pullRequests[pullRequestIndex]);
    }
  }

  return {
    issues: issues.items(),
    pullRequests: pullRequests.items(),
    loadedRepositories,
    erroredRepositories: repositories.length - loadedRepositories,
    issueCount,
    pullRequestCount,
    starCount,
    failingRuns
  };
}

export function makeErrorRepository(
  config: NullbuilderConfig,
  repo: RepoSlug,
  error: unknown,
  updatedAt = new Date().toISOString()
): RepositorySummary {
  const { owner, name } = repoSlugParts(repo);

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
  return (
    isFailingRun(repo.latestRuns.ci) ||
    isFailingRun(repo.latestRuns.nightly) ||
    isFailingRun(repo.latestRuns.release)
  );
}

function isFailingRun(run: RepositorySummary['latestRuns']['ci']): boolean {
  return run ? isFailingWorkflowRun(run.status, run.conclusion) : false;
}
