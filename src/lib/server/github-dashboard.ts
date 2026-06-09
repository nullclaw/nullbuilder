import type { RepoSlug } from '../repositories';
import type { NullbuilderConfig } from './config';
import { publicErrorMessage } from './github-client';

export type GitHubLabel = {
  name: string;
  color: string;
};

export type IssueSummary = {
  repo: RepoSlug;
  number: number;
  title: string;
  url: string;
  author: string;
  labels: GitHubLabel[];
  comments: number;
  createdAt: string;
  updatedAt: string;
};

export type PullRequestSummary = IssueSummary & {
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha: string;
};

export type WorkflowRunSummary = {
  id: number;
  name: string;
  path: string;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  url: string;
  branch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
};

export type StarGrowthSummary = {
  current: number | null;
  last7Days: number | null;
  last30Days: number | null;
};

export type RepositorySummary = {
  slug: RepoSlug;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
  defaultBranch: string;
  language: string | null;
  isPrivate: boolean;
  archived: boolean;
  stars: number | null;
  forks: number | null;
  openIssues: number | null;
  openPulls: number | null;
  pushedAt: string | null;
  updatedAt: string;
  issues: IssueSummary[];
  pullRequests: PullRequestSummary[];
  starGrowth: StarGrowthSummary;
  latestRuns: {
    ci: WorkflowRunSummary | null;
    nightly: WorkflowRunSummary | null;
    release: WorkflowRunSummary | null;
  };
  status: 'ok' | 'error';
  error?: string;
};

export type DashboardData = {
  generatedAt: string;
  hasToken: boolean;
  owner: string;
  repos: RepoSlug[];
  repositories: RepositorySummary[];
  issues: IssueSummary[];
  pullRequests: PullRequestSummary[];
  hasReadErrors: boolean;
  totals: {
    repositories: number;
    loadedRepositories: number;
    erroredRepositories: number;
    issues: number;
    pullRequests: number;
    stars: number;
    failingRuns: number;
  };
};

export type GitHubRepositoryResponse = {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  private: boolean;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string | null;
  updated_at: string;
  owner: {
    login: string;
  };
};

export type GitHubIssueResponse = {
  number: number;
  title: string;
  html_url: string;
  user: {
    login: string;
  } | null;
  labels: Array<string | { name?: string; color?: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
};

export type GitHubPullResponse = {
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  user: {
    login: string;
  } | null;
  labels?: Array<string | { name?: string; color?: string }>;
  comments?: number;
  created_at: string;
  updated_at: string;
  base: {
    ref: string;
    repo?: {
      full_name: string;
    };
  };
  head: {
    ref: string;
    sha: string;
    repo?: {
      full_name: string;
    } | null;
  };
};

export type GitHubWorkflowRunResponse = {
  id: number;
  name: string | null;
  path?: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string;
  event: string;
  created_at: string;
  updated_at: string;
};

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

export function mapRepositorySummary(
  repo: RepoSlug,
  repository: GitHubRepositoryResponse,
  issues: GitHubIssueResponse[],
  pulls: GitHubPullResponse[],
  workflowRuns: GitHubWorkflowRunResponse[],
  starGrowth: StarGrowthSummary
): RepositorySummary {
  const openIssues = issues.filter((issue) => !issue.pull_request).map((issue) => mapIssue(repo, issue));
  const pullRequests = pulls.map((pull) => mapPullRequest(repo, pull));

  return {
    slug: repo,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    url: repository.html_url,
    description: repository.description ?? '',
    defaultBranch: repository.default_branch,
    language: repository.language,
    isPrivate: repository.private,
    archived: repository.archived,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    openIssues: openIssues.length,
    openPulls: pullRequests.length,
    pushedAt: repository.pushed_at,
    updatedAt: repository.updated_at,
    issues: openIssues,
    pullRequests,
    starGrowth,
    latestRuns: mapLatestRuns(workflowRuns),
    status: 'ok'
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

export function mapLatestRuns(runs: GitHubWorkflowRunResponse[]): RepositorySummary['latestRuns'] {
  return {
    ci: mapRun(findRun(runs, ['ci', 'test'], ['ci.yml', 'zig-ci.yml'])),
    nightly: mapRun(findRun(runs, ['nightly'], ['nightly.yml', 'zig-nightly.yml'])),
    release: mapRun(findRun(runs, ['release'], ['release.yml', 'zig-release.yml']))
  };
}

export function sortByUpdatedAt(left: { updatedAt: string }, right: { updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function repositoryHasFailingRun(repo: RepositorySummary): boolean {
  const runs = Object.values(repo.latestRuns);
  return runs.some((run) => run?.status === 'completed' && run.conclusion !== 'success');
}

function mapIssue(repo: RepoSlug, issue: GitHubIssueResponse): IssueSummary {
  return {
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    author: issue.user?.login ?? 'unknown',
    labels: mapLabels(issue.labels),
    comments: issue.comments,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at
  };
}

function mapPullRequest(repo: RepoSlug, pull: GitHubPullResponse): PullRequestSummary {
  return {
    repo,
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: pull.user?.login ?? 'unknown',
    labels: mapLabels(pull.labels ?? []),
    comments: pull.comments ?? 0,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    draft: pull.draft,
    baseBranch: pull.base.ref,
    headBranch: pull.head.ref,
    headSha: pull.head.sha
  };
}

function mapLabels(labels: Array<string | { name?: string; color?: string }>): GitHubLabel[] {
  return labels.map((label) => {
    if (typeof label === 'string') {
      return {
        name: label,
        color: 'd0d7de'
      };
    }

    return {
      name: label.name ?? 'label',
      color: label.color ?? 'd0d7de'
    };
  });
}

function findRun(
  runs: GitHubWorkflowRunResponse[],
  nameKeywords: string[],
  pathKeywords: string[]
): GitHubWorkflowRunResponse | null {
  return (
    runs.find((run) => {
      const name = (run.name ?? '').toLowerCase();
      const path = (run.path ?? '').toLowerCase();
      return (
        nameKeywords.some((keyword) => name.includes(keyword)) ||
        pathKeywords.some((keyword) => path.endsWith(keyword) || path.includes(`/${keyword}`))
      );
    }) ?? null
  );
}

function mapRun(run: GitHubWorkflowRunResponse | null): WorkflowRunSummary | null {
  if (!run) {
    return null;
  }

  return {
    id: run.id,
    name: run.name ?? 'Workflow',
    path: run.path ?? '',
    displayTitle: run.display_title,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    branch: run.head_branch,
    event: run.event,
    createdAt: run.created_at,
    updatedAt: run.updated_at
  };
}
