import type { RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { publicErrorMessage } from './github-client';
import type { DashboardData, RepositorySummary } from './github-dashboard-types';

export { mapLatestRuns, mapRepositorySummary } from './github-dashboard-mappers';
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
  const issues = loadedRepositories.flatMap((repo) => repo.issues).sort(sortByUpdatedAt);
  const pullRequests = loadedRepositories.flatMap((repo) => repo.pullRequests).sort(sortByUpdatedAt);
  const failingRuns = loadedRepositories.filter(repositoryHasFailingRun).length;
  const erroredRepositories = repositories.length - loadedRepositories.length;

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
      issues: issues.length,
      pullRequests: pullRequests.length,
      stars: loadedRepositories.reduce((total, repo) => total + (repo.stars ?? 0), 0),
      failingRuns
    }
  };
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
    url: `${config.webBaseUrl}/${repo}`,
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
