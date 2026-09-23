// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One scan at a time, its answer kept a minute on the clock port: a
// request while a scan runs waits for that scan, one inside the minute
// gets the kept answer, and a failed scan keeps nothing.

import type { Clock } from "../lib/clock.ts";

export const KEEP_MS = 60_000;

export type Cache<T> = {
  get(): Promise<T>;
};

export function scanCache<T>(deps: {
  clock: Clock;
  run: () => Promise<T>;
  keepMs?: number;
}): Cache<T> {
  const keepMs = deps.keepMs ?? KEEP_MS;
  let kept: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  return {
    get() {
      const now = deps.clock();
      if (kept !== null && now - kept.at < keepMs) {
        return Promise.resolve(kept.value);
      }
      if (inflight === null) {
        inflight = deps
          .run()
          .then((value) => {
            kept = { at: deps.clock(), value };
            return value;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}
