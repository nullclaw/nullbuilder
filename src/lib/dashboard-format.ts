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
  if (!value) {
    return 'n/a';
  }

  return dashboardDateFormatter.format(new Date(value));
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
  return value === null ? 'unknown' : String(value);
}

export function formatGrowth(value: number | null): string {
  return value === null ? 'unknown' : `+${value}`;
}
