import type { RepoSlug } from '../repositories';
import type {
  GitHubIssueResponse,
  GitHubLabel,
  GitHubPullResponse,
  GitHubRepositoryResponse,
  GitHubWorkflowRunResponse,
  IssueSummary,
  PullRequestSummary,
  RepositoryLatestRuns,
  RepositorySummary,
  StarGrowthSummary,
  WorkflowRunSummary
} from './github-dashboard-types';

const DEFAULT_LABEL_COLOR = 'd0d7de';
const LABEL_COLOR_PATTERN = /^[0-9a-f]{6}$/i;

export function mapRepositorySummary(
  repo: RepoSlug,
  repository: GitHubRepositoryResponse,
  issues: GitHubIssueResponse[],
  pulls: GitHubPullResponse[],
  workflowRuns: GitHubWorkflowRunResponse[],
  starGrowth: StarGrowthSummary
): RepositorySummary {
  const openIssues = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => mapIssue(repo, issue));
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
    stars: safeNullableCount(repository.stargazers_count),
    forks: safeNullableCount(repository.forks_count),
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

export function mapLatestRuns(runs: GitHubWorkflowRunResponse[]): RepositoryLatestRuns {
  return {
    ci: mapRun(findRun(runs, ['ci', 'test'], ['ci.yml', 'zig-ci.yml'])),
    nightly: mapRun(findRun(runs, ['nightly'], ['nightly.yml', 'zig-nightly.yml'])),
    release: mapRun(findRun(runs, ['release'], ['release.yml', 'zig-release.yml']))
  };
}

function mapIssue(repo: RepoSlug, issue: GitHubIssueResponse): IssueSummary {
  return {
    repo,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    author: issue.user?.login ?? 'unknown',
    labels: mapLabels(issue.labels),
    comments: safeCount(issue.comments),
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
    comments: safeCount(pull.comments),
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
        color: DEFAULT_LABEL_COLOR
      };
    }

    return {
      name: label.name ?? 'label',
      color: normalizeLabelColor(label.color)
    };
  });
}

function normalizeLabelColor(color: string | undefined): string {
  return color && LABEL_COLOR_PATTERN.test(color) ? color.toLowerCase() : DEFAULT_LABEL_COLOR;
}

function safeCount(value: number | null | undefined): number {
  return safeNullableCount(value) ?? 0;
}

function safeNullableCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
