import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapWithConcurrency } from './concurrency';

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
