// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export function deferred<T>() {
  return Promise.withResolvers<T>();
}

export const settle = () => new Promise<void>((r) => setTimeout(r, 0));

// what the promise rejected with, by a plain await: Bun's test timeout
// fires there, never while expect(p).rejects waits on a promise that a
// regression left pending
export async function rejection(promise: unknown): Promise<Error> {
  const outcome = await Promise.resolve(promise).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  if (outcome === null) throw new Error("expected a rejection");
  return outcome.error as Error;
}
