import type { RepoSlug } from '../repositories';
import { sanitizeText } from '../text-safety';
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
export const MAX_DASHBOARD_TEXT_FIELD_LENGTH = 256;
export const MAX_WORK_ITEM_TITLE_LENGTH = 512;
export const MAX_TIMESTAMP_TEXT_LENGTH = 64;
export const MAX_LABELS_PER_WORK_ITEM = 20;
export const MAX_LABEL_NAME_LENGTH = 64;
export const MAX_REPOSITORY_WORK_ITEMS = 100;

export function mapRepositorySummary(
  repo: RepoSlug,
  repository: GitHubRepositoryResponse,
  issues: GitHubIssueResponse[],
  pulls: GitHubPullResponse[],
  workflowRuns: GitHubWorkflowRunResponse[],
  starGrowth: StarGrowthSummary
): RepositorySummary {
  const openIssues = mapIssueSummaries(repo, issues);
  const pullRequests = mapPullRequestSummaries(repo, pulls);
  const [fallbackOwner, fallbackName] = repo.split('/');

  return {
    slug: repo,
    owner: safeDashboardText(repository.owner.login, fallbackOwner),
    name: safeDashboardText(repository.name, fallbackName),
    fullName: safeDashboardText(repository.full_name, repo),
    url: repository.html_url,
    description: safeDashboardText(repository.description ?? '', ''),
    defaultBranch: safeDashboardText(repository.default_branch, 'unknown'),
    language: safeOptionalDashboardText(repository.language),
    isPrivate: repository.private,
    archived: repository.archived,
    stars: safeNullableCount(repository.stargazers_count),
    forks: safeNullableCount(repository.forks_count),
    openIssues: openIssues.total,
    openPulls: pullRequests.total,
    pushedAt: safeOptionalTimestamp(repository.pushed_at),
    updatedAt: safeTimestamp(repository.updated_at),
    issues: openIssues.items,
    pullRequests: pullRequests.items,
    starGrowth,
    latestRuns: mapLatestRuns(workflowRuns),
    status: 'ok'
  };
}

type BoundedWorkItems<T extends IssueSummary | PullRequestSummary> = {
  items: T[];
  total: number;
};

function mapIssueSummaries(repo: RepoSlug, issues: GitHubIssueResponse[]): BoundedWorkItems<IssueSummary> {
  return collectBoundedWorkItems(issues, (issue) => {
    if (issue.pull_request) {
      return null;
    }

    return mapIssue(repo, issue);
  });
}

function mapPullRequestSummaries(repo: RepoSlug, pulls: GitHubPullResponse[]): BoundedWorkItems<PullRequestSummary> {
  return collectBoundedWorkItems(pulls, (pull) => mapPullRequest(repo, pull));
}

function collectBoundedWorkItems<Input, Output extends IssueSummary | PullRequestSummary>(
  values: Input[],
  mapper: (value: Input) => Output | null,
  maxItems = MAX_REPOSITORY_WORK_ITEMS
): BoundedWorkItems<Output> {
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0) {
    return { items: [], total: 0 };
  }

  const items: RankedWorkItem<Output>[] = [];
  let total = 0;

  for (const value of values) {
    const item = mapper(value);
    if (item === null) {
      continue;
    }

    insertRecentWorkItem(
      items,
      {
        item,
        timestamp: updatedAtTimestamp(item.updatedAt),
        ordinal: total
      },
      maxItems
    );
    total = saturatingSafeIntegerAdd(total, 1);
  }

  return {
    items: items.map(({ item }) => item),
    total
  };
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

export function mapLatestRuns(runs: GitHubWorkflowRunResponse[]): RepositoryLatestRuns {
  return {
    ci: mapRun(findRun(runs, ['ci', 'test'], ['ci.yml', 'zig-ci.yml'])),
    nightly: mapRun(findRun(runs, ['nightly'], ['nightly.yml', 'zig-nightly.yml'])),
    release: mapRun(findRun(runs, ['release'], ['release.yml', 'zig-release.yml']))
  };
}

function mapIssue(repo: RepoSlug, issue: GitHubIssueResponse): IssueSummary | null {
  const number = safeWorkItemNumber(issue.number);
  if (number === null) {
    return null;
  }

  return {
    repo,
    number,
    title: safeWorkItemTitle(issue.title, 'Untitled issue'),
    url: issue.html_url,
    author: safeDashboardText(issue.user?.login ?? '', 'unknown'),
    labels: mapLabels(issue.labels),
    comments: safeCount(issue.comments),
    createdAt: safeTimestamp(issue.created_at),
    updatedAt: safeTimestamp(issue.updated_at)
  };
}

function mapPullRequest(repo: RepoSlug, pull: GitHubPullResponse): PullRequestSummary | null {
  const number = safeWorkItemNumber(pull.number);
  if (number === null) {
    return null;
  }

  return {
    repo,
    number,
    title: safeWorkItemTitle(pull.title, 'Untitled PR'),
    url: pull.html_url,
    author: safeDashboardText(pull.user?.login ?? '', 'unknown'),
    labels: mapLabels(pull.labels ?? []),
    comments: safeCount(pull.comments),
    createdAt: safeTimestamp(pull.created_at),
    updatedAt: safeTimestamp(pull.updated_at),
    draft: pull.draft,
    baseBranch: safeDashboardText(pull.base.ref, 'unknown'),
    headBranch: safeDashboardText(pull.head.ref, 'unknown'),
    headSha: safeDashboardText(pull.head.sha, 'unknown')
  };
}

function mapLabels(labels: Array<string | { name?: string; color?: string }>): GitHubLabel[] {
  const mapped: GitHubLabel[] = [];

  for (const label of labels) {
    if (mapped.length >= MAX_LABELS_PER_WORK_ITEM) {
      break;
    }

    if (typeof label === 'string') {
      mapped.push({
        name: safeLabelName(label),
        color: DEFAULT_LABEL_COLOR
      });
      continue;
    }

    mapped.push({
      name: safeLabelName(label.name),
      color: normalizeLabelColor(label.color)
    });
  }

  return mapped;
}

function safeLabelName(value: string | undefined): string {
  return sanitizeText(value ?? '', {
    maxLength: MAX_LABEL_NAME_LENGTH,
    fallback: 'label',
    trim: true
  });
}

function safeDashboardText(
  value: string | null | undefined,
  fallback: string,
  maxLength = MAX_DASHBOARD_TEXT_FIELD_LENGTH
): string {
  return sanitizeText(value ?? '', {
    maxLength,
    fallback,
    trim: true
  });
}

function safeOptionalDashboardText(value: string | null | undefined): string | null {
  const safe = safeDashboardText(value, '');
  return safe ? safe : null;
}

function safeWorkItemTitle(value: string, fallback: string): string {
  return safeDashboardText(value, fallback, MAX_WORK_ITEM_TITLE_LENGTH);
}

function safeTimestamp(value: string): string {
  return safeDashboardText(value, '', MAX_TIMESTAMP_TEXT_LENGTH);
}

function safeOptionalTimestamp(value: string | null): string | null {
  return value === null ? null : safeTimestamp(value);
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

function safeWorkItemNumber(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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

function findRun(
  runs: GitHubWorkflowRunResponse[],
  nameKeywords: string[],
  pathKeywords: string[]
): GitHubWorkflowRunResponse | null {
  return (
    runs.find((run) => {
      const name = safeDashboardText(run.name ?? '', '').toLowerCase();
      const path = safeDashboardText(run.path ?? '', '').toLowerCase();
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
    name: safeDashboardText(run.name ?? '', 'Workflow'),
    path: safeDashboardText(run.path ?? '', ''),
    displayTitle: safeDashboardText(run.display_title, 'Workflow'),
    status: safeDashboardText(run.status, 'unknown'),
    conclusion: run.conclusion === null ? null : safeDashboardText(run.conclusion, 'unknown'),
    url: run.html_url,
    branch: safeDashboardText(run.head_branch, 'unknown'),
    event: safeDashboardText(run.event, 'unknown'),
    createdAt: safeTimestamp(run.created_at),
    updatedAt: safeTimestamp(run.updated_at)
  };
}
