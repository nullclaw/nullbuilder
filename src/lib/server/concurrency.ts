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
  const state: MapWorkerState = {
    nextIndex: 0,
    stopped: false
  };
  const workerCount = normalizeWorkerCount(concurrency, values.length);
  const workers: Promise<void>[] = [];

  for (let index = 0; index < workerCount; index += 1) {
    workers.push(runMapWorker(values, results, state, mapper));
  }

  await Promise.all(workers);

  return results;
}

type MapWorkerState = {
  nextIndex: number;
  stopped: boolean;
};

async function runMapWorker<T, R>(
  values: readonly T[],
  results: R[],
  state: MapWorkerState,
  mapper: (value: T, index: number) => Promise<R>
): Promise<void> {
  while (!state.stopped) {
    const index = claimNextMapIndex(state, values.length);
    if (index === null) {
      return;
    }

    try {
      results[index] = await mapper(values[index], index);
    } catch (error) {
      state.stopped = true;
      throw error;
    }
  }
}

function claimNextMapIndex(state: MapWorkerState, valueCount: number): number | null {
  if (state.stopped || state.nextIndex >= valueCount) {
    return null;
  }

  const index = state.nextIndex;
  state.nextIndex += 1;
  return index;
}

function normalizeWorkerCount(concurrency: unknown, valueCount: number): number {
  const normalizedConcurrency = Math.max(
    1,
    normalizeBoundedNonNegativeInteger(concurrency, 1, MAX_MAP_CONCURRENCY)
  );

  return Math.min(normalizedConcurrency, valueCount);
}
