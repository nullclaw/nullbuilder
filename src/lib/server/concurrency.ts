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
    workers[index] = runMapWorker(values, results, state, mapper);
  }

  await settleStarted(workers);

  return results;
}

export function settleStarted<T1, T2>(
  reads: readonly [Promise<T1>, Promise<T2>]
): Promise<[T1, T2]>;
export function settleStarted<T1, T2, T3, T4>(
  reads: readonly [Promise<T1>, Promise<T2>, Promise<T3>, Promise<T4>]
): Promise<[T1, T2, T3, T4]>;
export function settleStarted<T1, T2, T3, T4, T5, T6, T7>(
  reads: readonly [
    Promise<T1>,
    Promise<T2>,
    Promise<T3>,
    Promise<T4>,
    Promise<T5>,
    Promise<T6>,
    Promise<T7>
  ]
): Promise<[T1, T2, T3, T4, T5, T6, T7]>;
export function settleStarted<T>(reads: readonly Promise<T>[]): Promise<T[]>;
export async function settleStarted(reads: readonly Promise<unknown>[]): Promise<unknown[]> {
  const results = await Promise.allSettled(reads);
  const values = new Array<unknown>(results.length);
  for (let index = 0; index < results.length; index += 1) {
    values[index] = fulfilledValue(results[index]);
  }
  return values;
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }

  return result.value;
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
