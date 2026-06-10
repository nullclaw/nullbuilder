import type { RepoSlug } from '../repositories';
import { safeUtcTimestampText } from '../date-safety';
import { sanitizeText } from '../text-safety';
import type {
  GitHubLabel,
  GitHubRepositoryResponse,
  IssueSummary,
  PullRequestSummary,
  RepositoryLatestRuns,
  RepositorySummary,
  StarGrowthSummary,
  WorkflowRunSummary
} from './github-dashboard-types';
import {
  EMPTY_GITHUB_WEB_URL_CONTEXT,
  githubActionsUrl,
  githubRepositoryUrlContext,
  MAX_GITHUB_WEB_URL_LENGTH,
  safeGitHubWebUrl,
  type GitHubWebUrlContext
} from './github-web-urls';
import { isSafePositiveInteger, safeNonNegativeInteger, saturatingSafeIntegerAdd } from '../number-safety';
import { hasValidRecentWorkItemLimit, RecentWorkItemCollector } from './recent-work-items';

const DEFAULT_LABEL_COLOR = 'd0d7de';
const LABEL_COLOR_PATTERN = /^[0-9a-f]{6}$/i;
export const MAX_DASHBOARD_TEXT_FIELD_LENGTH = 256;
export const MAX_WORK_ITEM_TITLE_LENGTH = 512;
export const MAX_TIMESTAMP_TEXT_LENGTH = 64;
export const MAX_DASHBOARD_URL_LENGTH = MAX_GITHUB_WEB_URL_LENGTH;
export const MAX_LABELS_PER_WORK_ITEM = 20;
export const MAX_LABEL_NAME_LENGTH = 64;
export const MAX_REPOSITORY_WORK_ITEMS = 100;
export const MAX_WORKFLOW_RUNS_PER_REPOSITORY = 100;

export function mapRepositorySummary(
  repo: RepoSlug,
  repository: GitHubRepositoryResponse,
  issues: unknown,
  pulls: unknown,
  workflowRuns: unknown,
  starGrowth: StarGrowthSummary,
  webBaseUrl = 'https://github.com'
): RepositorySummary {
  const urlContext = githubRepositoryUrlContext(webBaseUrl, repo, safeString(repository.html_url));
  const openIssues = mapIssueSummaries(repo, safeArray(issues), urlContext);
  const pullRequests = mapPullRequestSummaries(repo, safeArray(pulls), urlContext);
  const [fallbackOwner, fallbackName] = repo.split('/');

  return {
    slug: repo,
    owner: safeObjectText(repository.owner, 'login', fallbackOwner),
    name: safeDashboardText(repository.name, fallbackName),
    fullName: safeDashboardText(repository.full_name, repo),
    url: urlContext.repositoryUrl,
    description: safeDashboardText(repository.description ?? '', ''),
    defaultBranch: safeDashboardText(repository.default_branch, 'unknown'),
    language: safeOptionalDashboardText(repository.language),
    isPrivate: safeBoolean(repository.private),
    archived: safeBoolean(repository.archived),
    stars: safeNullableCount(repository.stargazers_count),
    forks: safeNullableCount(repository.forks_count),
    openIssues: openIssues.total,
    openPulls: pullRequests.total,
    pushedAt: safeOptionalTimestamp(repository.pushed_at),
    updatedAt: safeTimestamp(repository.updated_at),
    issues: openIssues.items,
    pullRequests: pullRequests.items,
    starGrowth,
    latestRuns: mapLatestRunsForRepository(safeArray(workflowRuns), urlContext),
    status: 'ok'
  };
}

type BoundedWorkItems<T extends IssueSummary | PullRequestSummary> = {
  items: T[];
  total: number;
};

function mapIssueSummaries(
  repo: RepoSlug,
  issues: unknown[],
  urlContext: GitHubWebUrlContext
): BoundedWorkItems<IssueSummary> {
  return collectBoundedWorkItems(issues, (issue) => mapIssue(repo, issue, urlContext));
}

function mapPullRequestSummaries(
  repo: RepoSlug,
  pulls: unknown[],
  urlContext: GitHubWebUrlContext
): BoundedWorkItems<PullRequestSummary> {
  return collectBoundedWorkItems(pulls, (pull) => mapPullRequest(repo, pull, urlContext));
}

function collectBoundedWorkItems<Input, Output extends IssueSummary | PullRequestSummary>(
  values: Input[],
  mapper: (value: Input) => Output | null,
  maxItems = MAX_REPOSITORY_WORK_ITEMS
): BoundedWorkItems<Output> {
  if (!hasValidRecentWorkItemLimit(maxItems)) {
    return { items: [], total: 0 };
  }

  const collector = new RecentWorkItemCollector<Output>(maxItems);
  let total = 0;

  for (const value of values) {
    const item = mapper(value);
    if (item === null) {
      continue;
    }

    collector.add(item);
    total = saturatingSafeIntegerAdd(total, 1);
  }

  return {
    items: collector.items(),
    total
  };
}

export function mapLatestRuns(runs: unknown): RepositoryLatestRuns {
  return mapLatestRunsForRepository(safeArray(runs), EMPTY_GITHUB_WEB_URL_CONTEXT);
}

function mapLatestRunsForRepository(
  runs: unknown[],
  urlContext: GitHubWebUrlContext
): RepositoryLatestRuns {
  const selectedRuns = selectLatestRuns(runs);

  return {
    ci: mapRun(selectedRuns.ci, urlContext),
    nightly: mapRun(selectedRuns.nightly, urlContext),
    release: mapRun(selectedRuns.release, urlContext)
  };
}

function mapIssue(repo: RepoSlug, value: unknown, urlContext: GitHubWebUrlContext): IssueSummary | null {
  const issue = objectRecord(value);
  if (!issue || issue.pull_request) {
    return null;
  }

  const number = safeWorkItemNumber(issue.number);
  if (number === null) {
    return null;
  }

  return {
    repo,
    number,
    title: safeWorkItemTitle(issue.title, 'Untitled issue'),
    url: safeGitHubWebUrl(
      safeString(issue.html_url),
      `${urlContext.repositoryUrl}/issues/${number}`,
      urlContext.repositoryOrigin,
      urlContext.repositoryPathPrefix
    ),
    author: safeObjectText(issue.user, 'login', 'unknown'),
    labels: mapLabels(issue.labels),
    comments: safeCount(issue.comments),
    createdAt: safeTimestamp(issue.created_at),
    updatedAt: safeTimestamp(issue.updated_at)
  };
}

function mapPullRequest(
  repo: RepoSlug,
  value: unknown,
  urlContext: GitHubWebUrlContext
): PullRequestSummary | null {
  const pull = objectRecord(value);
  if (!pull) {
    return null;
  }

  const number = safeWorkItemNumber(pull.number);
  if (number === null) {
    return null;
  }

  return {
    repo,
    number,
    title: safeWorkItemTitle(pull.title, 'Untitled PR'),
    url: safeGitHubWebUrl(
      safeString(pull.html_url),
      `${urlContext.repositoryUrl}/pull/${number}`,
      urlContext.repositoryOrigin,
      urlContext.repositoryPathPrefix
    ),
    author: safeObjectText(pull.user, 'login', 'unknown'),
    labels: mapLabels(pull.labels),
    comments: safeCount(pull.comments),
    createdAt: safeTimestamp(pull.created_at),
    updatedAt: safeTimestamp(pull.updated_at),
    draft: safeBoolean(pull.draft),
    baseBranch: safeObjectText(pull.base, 'ref', 'unknown'),
    headBranch: safeObjectText(pull.head, 'ref', 'unknown'),
    headSha: safeObjectText(pull.head, 'sha', 'unknown')
  };
}

function mapLabels(labels: unknown): GitHubLabel[] {
  if (!Array.isArray(labels)) {
    return [];
  }

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

    const labelObject = objectRecord(label);
    if (!labelObject) {
      continue;
    }

    mapped.push({
      name: safeLabelName(labelObject.name),
      color: normalizeLabelColor(labelObject.color)
    });
  }

  return mapped;
}

function safeLabelName(value: unknown): string {
  return sanitizeText(safeString(value), {
    maxLength: MAX_LABEL_NAME_LENGTH,
    fallback: 'label',
    trim: true
  });
}

function safeDashboardText(
  value: unknown,
  fallback: string,
  maxLength = MAX_DASHBOARD_TEXT_FIELD_LENGTH
): string {
  return sanitizeText(safeString(value), {
    maxLength,
    fallback,
    trim: true
  });
}

function safeOptionalDashboardText(value: unknown): string | null {
  const safe = safeDashboardText(value, '');
  return safe ? safe : null;
}

function safeWorkItemTitle(value: unknown, fallback: string): string {
  return safeDashboardText(value, fallback, MAX_WORK_ITEM_TITLE_LENGTH);
}

function safeTimestamp(value: unknown): string {
  return safeUtcTimestampText(value, { maxLength: MAX_TIMESTAMP_TEXT_LENGTH });
}

function safeOptionalTimestamp(value: unknown): string | null {
  return value === null ? null : safeTimestamp(value);
}

function normalizeLabelColor(color: unknown): string {
  return typeof color === 'string' && LABEL_COLOR_PATTERN.test(color) ? color.toLowerCase() : DEFAULT_LABEL_COLOR;
}

function safeCount(value: unknown): number {
  return safeNonNegativeInteger(value) ?? 0;
}

function safeNullableCount(value: unknown): number | null {
  return safeNonNegativeInteger(value);
}

function safeWorkItemNumber(value: unknown): number | null {
  return isSafePositiveInteger(value) ? value : null;
}

function safeWorkflowRunId(value: unknown): number | null {
  return isSafePositiveInteger(value) ? value : null;
}

function safeBoolean(value: unknown): boolean {
  return value === true;
}

type SelectedWorkflowRuns = {
  ci: unknown | null;
  nightly: unknown | null;
  release: unknown | null;
};

function selectLatestRuns(runs: unknown[]): SelectedWorkflowRuns {
  const selectedRuns: SelectedWorkflowRuns = {
    ci: null,
    nightly: null,
    release: null
  };
  const runCount = Math.min(runs.length, MAX_WORKFLOW_RUNS_PER_REPOSITORY);

  for (let index = 0; index < runCount; index += 1) {
    const runObject = objectRecord(runs[index]);
    if (!runObject) {
      continue;
    }

    const name = safeDashboardText(runObject.name, '').toLowerCase();
    const path = safeDashboardText(runObject.path, '').toLowerCase();

    if (selectedRuns.ci === null && matchesRun(name, path, ['ci', 'test'], ['ci.yml', 'zig-ci.yml'])) {
      selectedRuns.ci = runObject;
    }
    if (selectedRuns.nightly === null && matchesRun(name, path, ['nightly'], ['nightly.yml', 'zig-nightly.yml'])) {
      selectedRuns.nightly = runObject;
    }
    if (selectedRuns.release === null && matchesRun(name, path, ['release'], ['release.yml', 'zig-release.yml'])) {
      selectedRuns.release = runObject;
    }

    if (selectedRuns.ci !== null && selectedRuns.nightly !== null && selectedRuns.release !== null) {
      break;
    }
  }

  return selectedRuns;
}

function matchesRun(
  name: string,
  path: string,
  nameKeywords: string[],
  pathKeywords: string[]
): boolean {
  return (
    nameKeywords.some((keyword) => name.includes(keyword)) ||
    pathKeywords.some((keyword) => path.endsWith(keyword) || path.includes(`/${keyword}`))
  );
}

function mapRun(value: unknown, urlContext: GitHubWebUrlContext): WorkflowRunSummary | null {
  const run = objectRecord(value);
  if (!run) {
    return null;
  }

  return {
    id: safeWorkflowRunId(run.id),
    name: safeDashboardText(run.name ?? '', 'Workflow'),
    path: safeDashboardText(run.path ?? '', ''),
    displayTitle: safeDashboardText(run.display_title, 'Workflow'),
    status: safeDashboardText(run.status, 'unknown'),
    conclusion: run.conclusion === null ? null : safeDashboardText(run.conclusion, 'unknown'),
    url: safeGitHubWebUrl(
      safeString(run.html_url),
      githubActionsUrl(urlContext),
      urlContext.repositoryOrigin,
      urlContext.repositoryPathPrefix
    ),
    branch: safeDashboardText(run.head_branch, 'unknown'),
    event: safeDashboardText(run.event, 'unknown'),
    createdAt: safeTimestamp(run.created_at),
    updatedAt: safeTimestamp(run.updated_at)
  };
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeObjectText(value: unknown, key: string, fallback: string): string {
  return safeDashboardText(objectRecord(value)?.[key], fallback);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
