export async function mapInBatches<T, Result>(
  items: readonly T[],
  batchSize: number,
  operation: (item: T, index: number) => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) {
    throw new Error('ANALYZER_BATCH_SIZE_INVALID');
  }
  const results: Result[] = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    if (signal?.aborted) throw new Error('ANALYZER_REQUEST_CANCELLED');
    const batch = items.slice(offset, offset + batchSize);
    results.push(...await Promise.all(
      batch.map((item, index) => operation(item, offset + index)),
    ));
  }
  return results;
}
