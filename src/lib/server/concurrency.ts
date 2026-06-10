import { normalizeBoundedNonNegativeInteger } from '../number-safety';

export const MAX_MAP_CONCURRENCY = 10;
export const MAX_MAP_ITEMS = 1000;

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: unknown,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) {
    return [];
  }
  if (values.length > MAX_MAP_ITEMS) {
    throw new Error('Too many items to map.');
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = normalizeWorkerCount(concurrency, values.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
      }
    })
  );

  return results;
}

function normalizeWorkerCount(concurrency: unknown, valueCount: number): number {
  const normalizedConcurrency = Math.max(
    1,
    normalizeBoundedNonNegativeInteger(concurrency, 1, MAX_MAP_CONCURRENCY)
  );

  return Math.min(normalizedConcurrency, valueCount);
}
