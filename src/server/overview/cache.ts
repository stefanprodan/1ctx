// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One read at a time per key, its answer kept a minute on the clock
// port: a request while a read runs waits for that read, one inside
// the minute gets the kept answer, and a failed read keeps nothing.
// The storage scan has one key; the overview a key per zone and range.

import type { Clock } from "../lib/clock.ts";

export const KEEP_MS = 60_000;

export type Cache<T> = {
  get(key?: string): Promise<T>;
};

export function scanCache<T>(deps: {
  clock: Clock;
  run: (key: string) => Promise<T>;
  keepMs?: number;
}): Cache<T> {
  const keepMs = deps.keepMs ?? KEEP_MS;
  const kept = new Map<string, { at: number; value: T }>();
  const inflight = new Map<string, Promise<T>>();
  return {
    get(key = "") {
      const now = deps.clock();
      const have = kept.get(key);
      if (have !== undefined && now - have.at < keepMs) {
        return Promise.resolve(have.value);
      }
      let pending = inflight.get(key);
      if (pending === undefined) {
        pending = deps
          .run(key)
          .then((value) => {
            const at = deps.clock();
            // a zone asked once need not be kept past its minute
            for (const [other, entry] of kept) {
              if (at - entry.at >= keepMs) kept.delete(other);
            }
            kept.set(key, { at, value });
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
