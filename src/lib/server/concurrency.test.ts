import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapWithConcurrency, MAX_MAP_CONCURRENCY, MAX_MAP_ITEMS } from './concurrency';

test('mapWithConcurrency preserves input order', async () => {
  const values = [1, 2, 3, 4];
  const mapped = await mapWithConcurrency(values, 2, async (value) => value * 10);

  assert.deepEqual(mapped, [10, 20, 30, 40]);
});

test('mapWithConcurrency handles empty inputs', async () => {
  const mapped = await mapWithConcurrency([], 10, async (value: number) => value);

  assert.deepEqual(mapped, []);
});

test('mapWithConcurrency clamps invalid low concurrency to one worker', async () => {
  const seen: number[] = [];
  const mapped = await mapWithConcurrency([1, 2, 3], 0, async (value) => {
    seen.push(value);
    return value;
  });

  assert.deepEqual(mapped, [1, 2, 3]);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('mapWithConcurrency caps high concurrency to a bounded worker count', async () => {
  const values = Array.from({ length: MAX_MAP_CONCURRENCY + 5 }, (_, index) => index);
  let active = 0;
  let maxActive = 0;

  const mapped = await mapWithConcurrency(values, Number.MAX_SAFE_INTEGER, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return value;
  });

  assert.deepEqual(mapped, values);
  assert.equal(maxActive, MAX_MAP_CONCURRENCY);
});

test('mapWithConcurrency accepts inputs at the configured item cap', async () => {
  const values = Array.from({ length: MAX_MAP_ITEMS }, (_, index) => index);
  const mapped = await mapWithConcurrency(values, MAX_MAP_CONCURRENCY, async (value) => value + 1);

  assert.equal(mapped.length, MAX_MAP_ITEMS);
  assert.equal(mapped[0], 1);
  assert.equal(mapped[MAX_MAP_ITEMS - 1], MAX_MAP_ITEMS);
});

test('mapWithConcurrency rejects oversized input before starting workers', async () => {
  const values = Array.from({ length: MAX_MAP_ITEMS + 1 }, (_, index) => index);
  let mapped = false;

  await assert.rejects(
    mapWithConcurrency(values, 10, async () => {
      mapped = true;
      return 0;
    }),
    (error: unknown) => error instanceof Error && error.message === 'Too many items to map.'
  );

  assert.equal(mapped, false);
});
