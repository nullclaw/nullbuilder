export const WORKFLOW_RUN_COMPLETED_STATUS = 'completed';
export const WORKFLOW_RUN_FAILURE_CONCLUSION = 'failure';
export const WORKFLOW_RUN_MISSING_LABEL = 'n/a';
export const WORKFLOW_RUN_SUCCESS_CONCLUSION = 'success';
export const WORKFLOW_RUN_UNKNOWN_STATUS = 'unknown';

const WORKFLOW_RUN_STATUS_LABELS = Object.freeze([
  WORKFLOW_RUN_COMPLETED_STATUS,
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending'
] as const);
const WORKFLOW_RUN_RUNNING_STATUS_LABELS = Object.freeze([
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending'
] as const);
const WORKFLOW_RUN_CONCLUSION_LABELS = Object.freeze([
  WORKFLOW_RUN_SUCCESS_CONCLUSION,
  WORKFLOW_RUN_FAILURE_CONCLUSION,
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale'
] as const);

type CanonicalWorkflowRunStatus = (typeof WORKFLOW_RUN_STATUS_LABELS)[number];
type CanonicalWorkflowRunConclusion = (typeof WORKFLOW_RUN_CONCLUSION_LABELS)[number];

export type WorkflowRunStatus = CanonicalWorkflowRunStatus | typeof WORKFLOW_RUN_UNKNOWN_STATUS;
export type WorkflowRunConclusion = CanonicalWorkflowRunConclusion | null;

export function normalizeWorkflowRunStatus(value: string): WorkflowRunStatus {
  return matchCanonicalLabel(value, WORKFLOW_RUN_STATUS_LABELS) ?? WORKFLOW_RUN_UNKNOWN_STATUS;
}

export function normalizeWorkflowRunConclusion(value: string): Exclude<WorkflowRunConclusion, null> {
  return matchCanonicalLabel(value, WORKFLOW_RUN_CONCLUSION_LABELS) ?? WORKFLOW_RUN_FAILURE_CONCLUSION;
}

export function isCompletedWorkflowRunStatus(value: string): boolean {
  return value === WORKFLOW_RUN_COMPLETED_STATUS;
}

export function isRunningWorkflowRunStatus(value: string): boolean {
  return matchCanonicalLabel(value, WORKFLOW_RUN_RUNNING_STATUS_LABELS) !== null;
}

export function isSuccessfulWorkflowRunConclusion(value: string | null): boolean {
  return value === WORKFLOW_RUN_SUCCESS_CONCLUSION;
}

export function isFailingWorkflowRun(status: string, conclusion: string | null): boolean {
  return isCompletedWorkflowRunStatus(status) && !isSuccessfulWorkflowRunConclusion(conclusion);
}

function matchCanonicalLabel<const Labels extends readonly string[]>(
  value: string,
  labels: Labels
): Labels[number] | null {
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    if (value === label) {
      return label;
    }
  }

  return null;
}
