export const WORKFLOW_RUN_COMPLETED_STATUS = 'completed';
export const WORKFLOW_RUN_FAILURE_CONCLUSION = 'failure';
export const WORKFLOW_RUN_MISSING_LABEL = 'n/a';
export const WORKFLOW_RUN_SUCCESS_CONCLUSION = 'success';
export const WORKFLOW_RUN_UNKNOWN_STATUS = 'unknown';

export type WorkflowRunStatus =
  | typeof WORKFLOW_RUN_COMPLETED_STATUS
  | 'queued'
  | 'in_progress'
  | 'requested'
  | 'waiting'
  | 'pending'
  | typeof WORKFLOW_RUN_UNKNOWN_STATUS;

export type WorkflowRunConclusion =
  | typeof WORKFLOW_RUN_SUCCESS_CONCLUSION
  | typeof WORKFLOW_RUN_FAILURE_CONCLUSION
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'startup_failure'
  | 'stale'
  | null;

export function normalizeWorkflowRunStatus(value: string): WorkflowRunStatus {
  switch (value) {
    case WORKFLOW_RUN_COMPLETED_STATUS:
    case 'queued':
    case 'in_progress':
    case 'requested':
    case 'waiting':
    case 'pending':
      return value;
    default:
      return WORKFLOW_RUN_UNKNOWN_STATUS;
  }
}

export function normalizeWorkflowRunConclusion(value: string): Exclude<WorkflowRunConclusion, null> {
  switch (value) {
    case WORKFLOW_RUN_SUCCESS_CONCLUSION:
    case WORKFLOW_RUN_FAILURE_CONCLUSION:
    case 'neutral':
    case 'cancelled':
    case 'skipped':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
    case 'stale':
      return value;
    default:
      return WORKFLOW_RUN_FAILURE_CONCLUSION;
  }
}

export function isCompletedWorkflowRunStatus(value: string): boolean {
  return value === WORKFLOW_RUN_COMPLETED_STATUS;
}

export function isRunningWorkflowRunStatus(value: string): boolean {
  switch (value) {
    case 'queued':
    case 'in_progress':
    case 'requested':
    case 'waiting':
    case 'pending':
      return true;
    default:
      return false;
  }
}

export function isSuccessfulWorkflowRunConclusion(value: string | null): boolean {
  return value === WORKFLOW_RUN_SUCCESS_CONCLUSION;
}

export function isFailingWorkflowRun(status: string, conclusion: string | null): boolean {
  return isCompletedWorkflowRunStatus(status) && !isSuccessfulWorkflowRunConclusion(conclusion);
}
