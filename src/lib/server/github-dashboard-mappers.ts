import { repoSlugParts, type RepoSlug } from '../repositories';
import { parseUtcTimestampMillis, safeUtcTimestampText } from '../date-safety';
import { readBoundedArray, readObjectRecord } from '../record-safety';
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
export const MAX_LABELS_TO_SCAN = MAX_LABELS_PER_WORK_ITEM * 4;
export const MAX_LABEL_NAME_LENGTH = 64;
export const MAX_REPOSITORY_WORK_ITEMS = 100;
export const GITHUB_WORK_ITEMS_PAGE_SIZE = 100;
export const MAX_REPOSITORY_WORK_ITEM_PAGES_TO_SCAN = 20;
export const MAX_REPOSITORY_WORK_ITEMS_TO_SCAN =
  GITHUB_WORK_ITEMS_PAGE_SIZE * MAX_REPOSITORY_WORK_ITEM_PAGES_TO_SCAN;
export const MAX_WORKFLOW_RUNS_PER_REPOSITORY = 100;
const CI_RUN_NAME_KEYWORDS = ['ci', 'test'] as const;
const CI_RUN_PATH_KEYWORDS = ['ci.yml', 'zig-ci.yml'] as const;
const NIGHTLY_RUN_NAME_KEYWORDS = ['nightly'] as const;
const NIGHTLY_RUN_PATH_KEYWORDS = ['nightly.yml', 'zig-nightly.yml'] as const;
const RELEASE_RUN_NAME_KEYWORDS = ['release'] as const;
const RELEASE_RUN_PATH_KEYWORDS = ['release.yml', 'zig-release.yml'] as const;

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
  const openIssues = mapIssueSummaries(repo, issues, urlContext);
  const pullRequests = mapPullRequestSummaries(repo, pulls, urlContext);
  const fallback = repoSlugParts(repo);

  return {
    slug: repo,
    owner: safeObjectText(repository.owner, 'login', fallback.owner),
    name: safeDashboardText(repository.name, fallback.name),
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
    latestRuns: mapLatestRunsForRepository(workflowRuns, urlContext),
    status: 'ok'
  };
}

type BoundedWorkItems<T extends IssueSummary | PullRequestSummary> = {
  items: T[];
  total: number;
};

function mapIssueSummaries(
  repo: RepoSlug,
  issues: unknown,
  urlContext: GitHubWebUrlContext
): BoundedWorkItems<IssueSummary> {
  return collectBoundedWorkItems(
    readBoundedArray(issues, MAX_REPOSITORY_WORK_ITEMS_TO_SCAN),
    (issue) => mapIssue(repo, issue, urlContext)
  );
}

function mapPullRequestSummaries(
  repo: RepoSlug,
  pulls: unknown,
  urlContext: GitHubWebUrlContext
): BoundedWorkItems<PullRequestSummary> {
  return collectBoundedWorkItems(
    readBoundedArray(pulls, MAX_REPOSITORY_WORK_ITEMS_TO_SCAN),
    (pull) => mapPullRequest(repo, pull, urlContext)
  );
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

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
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
  return mapLatestRunsForRepository(runs, EMPTY_GITHUB_WEB_URL_CONTEXT);
}

function mapLatestRunsForRepository(
  runs: unknown,
  urlContext: GitHubWebUrlContext
): RepositoryLatestRuns {
  const selectedRuns = selectLatestRuns(readBoundedArray(runs, MAX_WORKFLOW_RUNS_PER_REPOSITORY));

  return {
    ci: mapRun(selectedRuns.ci, urlContext),
    nightly: mapRun(selectedRuns.nightly, urlContext),
    release: mapRun(selectedRuns.release, urlContext)
  };
}

function mapIssue(repo: RepoSlug, value: unknown, urlContext: GitHubWebUrlContext): IssueSummary | null {
  const issue = readObjectRecord(value);
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
  const pull = readObjectRecord(value);
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
  const mapped: GitHubLabel[] = [];
  const boundedLabels = readBoundedArray(labels, MAX_LABELS_TO_SCAN);

  for (let index = 0; index < boundedLabels.length; index += 1) {
    if (mapped.length >= MAX_LABELS_PER_WORK_ITEM) {
      break;
    }
    const label = boundedLabels[index];
    if (typeof label === 'string') {
      mapped[mapped.length] = {
        name: safeLabelName(label),
        color: DEFAULT_LABEL_COLOR
      };
      continue;
    }

    const labelObject = readObjectRecord(label);
    if (!labelObject) {
      continue;
    }

    mapped[mapped.length] = {
      name: safeLabelName(labelObject.name),
      color: normalizeLabelColor(labelObject.color)
    };
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

type RankedWorkflowRun = {
  run: Record<string, unknown>;
  timestamp: number;
  ordinal: number;
};

function selectLatestRuns(runs: unknown[]): SelectedWorkflowRuns {
  const selectedRuns: Record<keyof SelectedWorkflowRuns, RankedWorkflowRun | null> = {
    ci: null,
    nightly: null,
    release: null
  };

  for (let ordinal = 0; ordinal < runs.length; ordinal += 1) {
    const run = runs[ordinal];
    const runObject = readObjectRecord(run);
    if (!runObject) {
      continue;
    }

    const name = safeDashboardText(runObject.name, '').toLowerCase();
    const path = safeDashboardText(runObject.path, '').toLowerCase();
    const rankedRun = {
      run: runObject,
      timestamp: workflowRunTimestamp(runObject),
      ordinal
    };

    if (matchesRun(name, path, CI_RUN_NAME_KEYWORDS, CI_RUN_PATH_KEYWORDS)) {
      selectedRuns.ci = newerWorkflowRun(rankedRun, selectedRuns.ci);
    }
    if (matchesRun(name, path, NIGHTLY_RUN_NAME_KEYWORDS, NIGHTLY_RUN_PATH_KEYWORDS)) {
      selectedRuns.nightly = newerWorkflowRun(rankedRun, selectedRuns.nightly);
    }
    if (matchesRun(name, path, RELEASE_RUN_NAME_KEYWORDS, RELEASE_RUN_PATH_KEYWORDS)) {
      selectedRuns.release = newerWorkflowRun(rankedRun, selectedRuns.release);
    }
  }

  return {
    ci: selectedRuns.ci?.run ?? null,
    nightly: selectedRuns.nightly?.run ?? null,
    release: selectedRuns.release?.run ?? null
  };
}

function newerWorkflowRun(candidate: RankedWorkflowRun, current: RankedWorkflowRun | null): RankedWorkflowRun {
  if (current === null) {
    return candidate;
  }
  if (candidate.timestamp > current.timestamp) {
    return candidate;
  }
  if (candidate.timestamp < current.timestamp) {
    return current;
  }

  return candidate.ordinal < current.ordinal ? candidate : current;
}

function workflowRunTimestamp(run: Record<string, unknown>): number {
  return (
    parseUtcTimestampMillis(run.updated_at, { maxLength: MAX_TIMESTAMP_TEXT_LENGTH }) ??
    parseUtcTimestampMillis(run.created_at, { maxLength: MAX_TIMESTAMP_TEXT_LENGTH }) ??
    Number.NEGATIVE_INFINITY
  );
}

function matchesRun(
  name: string,
  path: string,
  nameKeywords: readonly string[],
  pathKeywords: readonly string[]
): boolean {
  for (let index = 0; index < nameKeywords.length; index += 1) {
    if (name.includes(nameKeywords[index])) {
      return true;
    }
  }

  for (let index = 0; index < pathKeywords.length; index += 1) {
    const keyword = pathKeywords[index];
    if (path.endsWith(keyword) || path.includes(`/${keyword}`)) {
      return true;
    }
  }

  return false;
}

function mapRun(value: unknown, urlContext: GitHubWebUrlContext): WorkflowRunSummary | null {
  const run = readObjectRecord(value);
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

function safeObjectText(value: unknown, key: string, fallback: string): string {
  return safeDashboardText(readObjectRecord(value)?.[key], fallback);
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
