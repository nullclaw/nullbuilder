import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isFailingWorkflowRun,
  isRunningWorkflowRunStatus,
  normalizeWorkflowRunConclusion,
  normalizeWorkflowRunStatus
} from './workflow-run-labels';

const originalArrayIterator = Array.prototype[Symbol.iterator];

test('workflow run labels normalize to GitHub Actions status and conclusion domains', () => {
  assert.equal(normalizeWorkflowRunStatus('completed'), 'completed');
  assert.equal(normalizeWorkflowRunStatus('queued'), 'queued');
  assert.equal(normalizeWorkflowRunStatus('in_progress'), 'in_progress');
  assert.equal(normalizeWorkflowRunStatus('requested'), 'requested');
  assert.equal(normalizeWorkflowRunStatus('waiting'), 'waiting');
  assert.equal(normalizeWorkflowRunStatus('pending'), 'pending');
  assert.equal(normalizeWorkflowRunStatus('success'), 'unknown');
  assert.equal(normalizeWorkflowRunStatus('completed\n'), 'unknown');
  assert.equal(normalizeWorkflowRunStatus('deploying-secret'), 'unknown');

  assert.equal(normalizeWorkflowRunConclusion('success'), 'success');
  assert.equal(normalizeWorkflowRunConclusion('failure'), 'failure');
  assert.equal(normalizeWorkflowRunConclusion('neutral'), 'neutral');
  assert.equal(normalizeWorkflowRunConclusion('cancelled'), 'cancelled');
  assert.equal(normalizeWorkflowRunConclusion('skipped'), 'skipped');
  assert.equal(normalizeWorkflowRunConclusion('timed_out'), 'timed_out');
  assert.equal(normalizeWorkflowRunConclusion('action_required'), 'action_required');
  assert.equal(normalizeWorkflowRunConclusion('startup_failure'), 'startup_failure');
  assert.equal(normalizeWorkflowRunConclusion('stale'), 'stale');
  assert.equal(normalizeWorkflowRunConclusion('queued'), 'failure');
  assert.equal(normalizeWorkflowRunConclusion('success\n'), 'failure');
  assert.equal(normalizeWorkflowRunConclusion('private-secret'), 'failure');
});

test('workflow run label classifiers avoid treating unknown statuses as running', () => {
  assert.equal(isRunningWorkflowRunStatus('queued'), true);
  assert.equal(isRunningWorkflowRunStatus('unknown'), false);
  assert.equal(isRunningWorkflowRunStatus('deploying-secret'), false);

  assert.equal(isFailingWorkflowRun('completed', 'failure'), true);
  assert.equal(isFailingWorkflowRun('completed', null), true);
  assert.equal(isFailingWorkflowRun('completed', 'success'), false);
  assert.equal(isFailingWorkflowRun('unknown', 'failure'), false);
});

test('workflow run label normalization avoids array iterators', () => {
  Array.prototype[Symbol.iterator] = function arrayIteratorShouldNotBeCalled(): ArrayIterator<unknown> {
    throw new Error('Array.prototype[Symbol.iterator] should not be called');
  };

  try {
    assert.equal(normalizeWorkflowRunStatus('queued'), 'queued');
    assert.equal(normalizeWorkflowRunStatus('deploying-secret'), 'unknown');
    assert.equal(normalizeWorkflowRunConclusion('cancelled'), 'cancelled');
    assert.equal(normalizeWorkflowRunConclusion('private-secret'), 'failure');
    assert.equal(isRunningWorkflowRunStatus('waiting'), true);
    assert.equal(isRunningWorkflowRunStatus('completed'), false);
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
  }
});
