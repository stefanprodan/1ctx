// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One read at a time per key, its answer kept a minute on the clock
// port: a request while a read runs waits for that read, one inside
// the minute gets the kept answer, and a failed read keeps nothing.
// The storage scan has one key; the overview a key per zone and range.
// Expired answers go on every get, and past MAX_KEPT keys the oldest.

import type { Clock } from "../lib/clock.ts";

export const KEEP_MS = 60_000;
export const MAX_KEPT = 32;

export type Cache<T> = {
  get(key?: string): Promise<T>;
};

export function scanCache<T>(deps: {
  clock: Clock;
  run: (key: string) => Promise<T>;
  keepMs?: number;
}): Cache<T> {
  const keepMs = deps.keepMs ?? KEEP_MS;
  // insertion order is age: a key set again is deleted first
  const kept = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  const sweep = (now: number) => {
    for (const [key, entry] of kept) {
      if (now - entry.at >= keepMs) kept.delete(key);
    }
  };
  return {
    get(key = "") {
      sweep(deps.clock());
      const have = kept.get(key);
      if (have !== undefined) return Promise.resolve(have.value);
      let pending = inflight.get(key);
      if (pending === undefined) {
        pending = deps
          .run(key)
          .then((value) => {
            kept.delete(key);
            kept.set(key, { at: deps.clock(), value });
            while (kept.size > MAX_KEPT) {
              kept.delete(kept.keys().next().value!);
            }
            return value;
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, pending);
      }
      return pending;
    },
  };
}
