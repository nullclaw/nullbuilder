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
    return 'n/a';
  }

  if (run.status !== 'completed') {
    return run.status;
  }

  return run.conclusion ?? 'completed';
}

export function workflowRunClass(run: WorkflowRunLike): WorkflowRunClass {
  if (!run) {
    return 'muted';
  }

  if (run.status !== 'completed') {
    return 'running';
  }

  return run.conclusion === 'success' ? 'success' : 'failed';
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
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}
