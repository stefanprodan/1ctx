/**
 * (1ctx find-batch) Promise.all that waits for every promise before failing
 * on the first rejection in order. Promise.all fails at the first and leaves
 * the rest of a batch reading; one that rejects after the command returned
 * is an unhandled rejection under the defense-in-depth box, which can end
 * the worker. find has upstream's own copy (#451).
 */
export async function settleAll<T extends readonly unknown[] | []>(
  work: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const settled = await Promise.allSettled(work);
  const values: unknown[] = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    values.push(result.value);
  }
  return values as { -readonly [K in keyof T]: Awaited<T[K]> };
}
