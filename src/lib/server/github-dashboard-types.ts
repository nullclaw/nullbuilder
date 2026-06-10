import type { RepoSlug } from '../repositories';

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
  id: number | null;
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

export type RepositoryLatestRuns = {
  ci: WorkflowRunSummary | null;
  nightly: WorkflowRunSummary | null;
  release: WorkflowRunSummary | null;
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
  latestRuns: RepositoryLatestRuns;
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
