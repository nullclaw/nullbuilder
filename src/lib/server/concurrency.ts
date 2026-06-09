export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) {
    return [];
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  const workerCount = Math.min(normalizedConcurrency, values.length);

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
