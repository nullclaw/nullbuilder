import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  collectRecentWorkItems,
  compareByUpdatedAtDesc,
  hasValidRecentWorkItemLimit,
  MAX_RECENT_WORK_ITEM_LIMIT,
  RecentWorkItemCollector,
  type WorkItemWithUpdatedAt
} from './recent-work-items';

type TestWorkItem = WorkItemWithUpdatedAt & {
  id: number;
};

test('RecentWorkItemCollector keeps the newest bounded rows with stable timestamp ties', () => {
  const collector = new RecentWorkItemCollector<TestWorkItem>(3);

  collector.add(workItem(1, '2026-06-09T00:00:00Z'));
  collector.add(workItem(2, '2026-06-09T00:03:00Z'));
  collector.add(workItem(3, '2026-06-09T00:03:00Z'));
  collector.add(workItem(4, '2026-06-09T00:01:00Z'));
  collector.add(workItem(5, '2026-06-09T00:04:00Z'));

  assert.deepEqual(collector.items().map(({ id }) => id), [5, 2, 3]);
});

test('collectRecentWorkItems treats invalid timestamps as older than valid timestamps', () => {
  const items = [
    workItem(1, 'not-a-date'),
    workItem(2, '1960-01-01T00:00:00Z'),
    workItem(3, ''),
    workItem(4, '2026-06-09T00:00:00Z')
  ];

  assert.deepEqual(collectRecentWorkItems(items, 3).map(({ id }) => id), [4, 2, 1]);
});

test('recent work item helpers reject unsafe limits', () => {
  assert.equal(hasValidRecentWorkItemLimit(MAX_RECENT_WORK_ITEM_LIMIT), true);
  assert.equal(hasValidRecentWorkItemLimit(0), false);
  assert.equal(hasValidRecentWorkItemLimit(1.5), false);
  assert.equal(hasValidRecentWorkItemLimit(MAX_RECENT_WORK_ITEM_LIMIT + 1), false);
  assert.equal(hasValidRecentWorkItemLimit(Number.MAX_SAFE_INTEGER + 1), false);
  assert.deepEqual(collectRecentWorkItems([workItem(1, '2026-06-09T00:00:00Z')], 0), []);
  assert.deepEqual(
    collectRecentWorkItems([workItem(1, '2026-06-09T00:00:00Z')], MAX_RECENT_WORK_ITEM_LIMIT + 1),
    []
  );
});

test('compareByUpdatedAtDesc orders invalid timestamps after any valid timestamp', () => {
  assert.equal(
    compareByUpdatedAtDesc(workItem(1, 'not-a-date'), workItem(2, '1960-01-01T00:00:00Z')),
    1
  );
  assert.equal(
    compareByUpdatedAtDesc(workItem(1, '2026-06-09T00:00:00Z'), workItem(2, '2026-06-09T00:00:00Z')),
    0
  );
});

test('recent work item helpers reject unsafe and non-UTC timestamps', () => {
  const items = [
    workItem(1, '2026-06-09T00:00:00Z'),
    workItem(2, '2026-06-10T00:00:00Z\nhidden'),
    workItem(3, '2026-06-11T00:00:00Z'.padEnd(128, 'x')),
    workItem(4, '2026-06-08T00:00:00Z'),
    workItem(5, '2026-06-12'),
    workItem(6, '2026-06-13T00:00:00+00:00')
  ];

  assert.deepEqual(collectRecentWorkItems(items, 6).map(({ id }) => id), [1, 4, 2, 3, 5, 6]);
});

function workItem(id: number, updatedAt: string): TestWorkItem {
  return { id, updatedAt };
}
