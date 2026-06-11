import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mapWithConcurrency, MAX_MAP_CONCURRENCY, MAX_MAP_ITEMS, settleStarted } from './concurrency';

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

test('mapWithConcurrency normalizes malformed runtime concurrency to one worker', async () => {
  const seen: number[] = [];
  const mapped = await mapWithConcurrency([1, 2, 3], '2', async (value) => {
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

test('mapWithConcurrency starts workers without global array push hooks', async () => {
  const originalPush = Array.prototype.push;
  let pushCalls = 0;
  let mapped: number[] | undefined;

  Object.defineProperty(Array.prototype, 'push', {
    configurable: true,
    writable: true,
    value() {
      pushCalls += 1;
      throw new Error('Array.prototype.push should not be called');
    }
  });

  try {
    mapped = await mapWithConcurrency([1, 2, 3, 4], 3, async (value) => value * 2);
  } finally {
    Object.defineProperty(Array.prototype, 'push', {
      configurable: true,
      writable: true,
      value: originalPush
    });
  }

  assert.equal(pushCalls, 0);
  assert.deepEqual(mapped, [2, 4, 6, 8]);
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

test('mapWithConcurrency waits for started workers after mapper failures', async () => {
  const failure = new Error('mapper failed');
  const seen: number[] = [];
  let releaseSecondMapper!: () => void;
  let settled = false;
  const secondMapperReleased = new Promise<void>((resolve) => {
    releaseSecondMapper = resolve;
  });

  const mapped = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    seen.push(value);

    if (value === 1) {
      throw failure;
    }

    if (value === 2) {
      await secondMapperReleased;
    }

    return value;
  });
  mapped.finally(() => {
    settled = true;
  }).catch(() => undefined);

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(settled, false);
  assert.deepEqual(seen, [1, 2]);
  releaseSecondMapper();

  await assert.rejects(mapped, (error: unknown) => error === failure);
  assert.equal(settled, true);
  assert.deepEqual(seen, [1, 2]);
});

test('settleStarted waits for all started promises before rethrowing', async () => {
  const failure = new Error('read failed');
  let releaseSecondRead!: () => void;
  let settled = false;
  const secondRead = new Promise<number>((resolve) => {
    releaseSecondRead = () => resolve(2);
  });

  const reads = settleStarted([Promise.reject(failure), secondRead] as const);
  reads.finally(() => {
    settled = true;
  }).catch(() => undefined);

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(settled, false);
  releaseSecondRead();

  await assert.rejects(reads, (error: unknown) => error === failure);
  assert.equal(settled, true);
});

test('settleStarted preserves wide tuple order and waits after rejection', async () => {
  const failure = new Error('wide read failed');
  let releaseLastRead!: () => void;
  let settled = false;
  const lastRead = new Promise<number>((resolve) => {
    releaseLastRead = () => resolve(7);
  });

  const reads = settleStarted([
    Promise.resolve(1),
    Promise.resolve(2),
    Promise.reject(failure),
    Promise.resolve(4),
    Promise.resolve(5),
    Promise.resolve(6),
    lastRead
  ] as const);
  reads.finally(() => {
    settled = true;
  }).catch(() => undefined);

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(settled, false);
  releaseLastRead();

  await assert.rejects(reads, (error: unknown) => error === failure);
  assert.equal(settled, true);

  const ordered = await settleStarted([
    Promise.resolve(1),
    Promise.resolve(2),
    Promise.resolve(3),
    Promise.resolve(4),
    Promise.resolve(5),
    Promise.resolve(6),
    Promise.resolve(7)
  ] as const);
  assert.deepEqual(ordered, [1, 2, 3, 4, 5, 6, 7]);
});

test('settleStarted avoids global array map hooks when collecting results', async () => {
  const originalMap = Array.prototype.map;
  Array.prototype.map = function mapShouldNotBeCalled(): never {
    throw new Error('Array.prototype.map should not be called');
  } as typeof Array.prototype.map;

  let values: [number, number] | undefined;
  try {
    values = await settleStarted([Promise.resolve(1), Promise.resolve(2)] as const);
  } finally {
    Array.prototype.map = originalMap;
  }

  assert.deepEqual(values, [1, 2]);
});
