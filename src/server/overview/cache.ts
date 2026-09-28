// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Clock } from "../lib/clock.ts";

export const KEEP_MS = 60_000;
// under the pages' 30 s poll: a kept answer is stamped when its read
// ends, after the ask
export const BOARD_KEEP_MS = 25_000;
export const MAX_KEPT = 32;

type Cache<T> = {
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
