import { parseUtcTimestampMillis } from './date-safety';
import {
  isCompletedWorkflowRunStatus,
  isRunningWorkflowRunStatus,
  isSuccessfulWorkflowRunConclusion,
  normalizeWorkflowRunConclusion,
  normalizeWorkflowRunStatus,
  WORKFLOW_RUN_COMPLETED_STATUS,
  WORKFLOW_RUN_MISSING_LABEL
} from './workflow-run-labels';

type WorkflowRunLike = {
  status: string;
  conclusion: string | null;
} | null;

export type WorkflowRunClass = 'muted' | 'running' | 'success' | 'failed';

const dashboardDateFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});
const MAX_DASHBOARD_DATE_LENGTH = 64;

export function formatDashboardDate(value: string | null): string {
  const date = parseDashboardDate(value);
  if (!date) {
    return 'n/a';
  }

  return dashboardDateFormatter.format(date);
}

export function formatDashboardDateOnly(value: string | null): string {
  const date = parseDashboardDate(value);
  return date ? date.toISOString().slice(0, 10) : 'n/a';
}

export function workflowRunLabel(run: WorkflowRunLike): string {
  if (!run) {
    return WORKFLOW_RUN_MISSING_LABEL;
  }

  const status = normalizeWorkflowRunStatus(run.status);
  if (!isCompletedWorkflowRunStatus(status)) {
    return status;
  }

  return run.conclusion === null ? WORKFLOW_RUN_COMPLETED_STATUS : normalizeWorkflowRunConclusion(run.conclusion);
}

export function workflowRunClass(run: WorkflowRunLike): WorkflowRunClass {
  if (!run) {
    return 'muted';
  }

  const status = normalizeWorkflowRunStatus(run.status);
  if (isRunningWorkflowRunStatus(status)) {
    return 'running';
  }

  if (!isCompletedWorkflowRunStatus(status)) {
    return 'muted';
  }

  return isSuccessfulWorkflowRunConclusion(run.conclusion) ? 'success' : 'failed';
}

export function formatNullableNumber(value: number | null): string {
  return isDisplayCount(value) ? String(value) : 'unknown';
}

export function formatGrowth(value: number | null): string {
  return isDisplayCount(value) ? `+${value}` : 'unknown';
}

function isDisplayCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function parseDashboardDate(value: string | null): Date | null {
  const timestamp = parseUtcTimestampMillis(value, { maxLength: MAX_DASHBOARD_DATE_LENGTH });
  return timestamp === null ? null : new Date(timestamp);
}
