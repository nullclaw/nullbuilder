import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  formatDashboardDate,
  formatDashboardDateOnly,
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
  assert.equal(formatDashboardDate('not-a-date'), 'n/a');
  assert.equal(formatDashboardDateOnly(null), 'n/a');
  assert.equal(formatDashboardDateOnly('not-a-date'), 'n/a');
  assert.equal(formatDashboardDateOnly('2026-06-02T12:34:56Z'), '2026-06-02');
});

test('format helpers bound and sanitize date inputs before parsing', () => {
  const oversized = `${' '.repeat(65)}2026-06-02T12:34:56Z`;

  assert.equal(formatDashboardDate(oversized), 'n/a');
  assert.equal(formatDashboardDateOnly(oversized), 'n/a');
  assert.equal(formatDashboardDate('2026-06-02T12:34:56Z\nhidden'), 'n/a');
  assert.equal(formatDashboardDateOnly('2026-06-02T12:34:56Z\x85hidden'), 'n/a');
});

test('format helpers accept only strict UTC dashboard dates', () => {
  for (const value of [
    '2026-06-02',
    '2026-06-02 12:34:56',
    '2026-06-02T12:34:56',
    '2026-06-02T12:34:56+00:00',
    '2026-02-29T00:00:00Z'
  ]) {
    assert.equal(formatDashboardDate(value), 'n/a');
    assert.equal(formatDashboardDateOnly(value), 'n/a');
  }

  assert.equal(formatDashboardDateOnly('2026-06-02T12:34:56.789Z'), '2026-06-02');
});

test('format helpers treat unsafe numbers as unknown display values', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    assert.equal(formatNullableNumber(value), 'unknown');
    assert.equal(formatGrowth(value), 'unknown');
  }
});
