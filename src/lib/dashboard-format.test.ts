import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  formatDashboardDate,
  formatGrowth,
  formatNullableNumber,
  workflowRunClass,
  workflowRunLabel
} from './dashboard-format';

test('workflowRunLabel reports missing active and completed runs', () => {
  assert.equal(workflowRunLabel(null), 'n/a');
  assert.equal(workflowRunLabel({ status: 'in_progress', conclusion: null }), 'in_progress');
  assert.equal(workflowRunLabel({ status: 'completed', conclusion: 'success' }), 'success');
  assert.equal(workflowRunLabel({ status: 'completed', conclusion: null }), 'completed');
});

test('workflowRunClass maps run state to presentation classes', () => {
  assert.equal(workflowRunClass(null), 'muted');
  assert.equal(workflowRunClass({ status: 'queued', conclusion: null }), 'running');
  assert.equal(workflowRunClass({ status: 'completed', conclusion: 'success' }), 'success');
  assert.equal(workflowRunClass({ status: 'completed', conclusion: 'failure' }), 'failed');
});

test('format helpers keep null values explicit', () => {
  assert.equal(formatNullableNumber(null), 'unknown');
  assert.equal(formatNullableNumber(42), '42');
  assert.equal(formatGrowth(null), 'unknown');
  assert.equal(formatGrowth(7), '+7');
  assert.equal(formatDashboardDate(null), 'n/a');
});
