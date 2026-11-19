// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How many process slots are free now: each is asked for, the ones
// granted by the next turn of the event loop are counted, then every
// one is given back and the rest of the asks dropped.

import { PROCESS_SLOTS } from "../../src/server/knowledge/limits.ts";
import { acquireProcess } from "../../src/server/knowledge/queue.ts";

export async function freeSlots(): Promise<number> {
  const stop = new AbortController();
  const granted: (() => void)[] = [];
  const asks = Array.from({ length: PROCESS_SLOTS }, () =>
    acquireProcess(stop.signal).then(
      (release) => {
        granted.push(release);
      },
      () => {},
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const free = granted.length;
  stop.abort();
  await Promise.all(asks);
  for (const release of granted) release();
  return free;
}
