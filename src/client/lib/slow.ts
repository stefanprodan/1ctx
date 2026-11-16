// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether a wait has gone on long enough to say so in words. Bones say
// a load runs; a word drawn at once beside them would flash on every
// fast answer, so the words wait SLOW_MS, on the waits' own clock.

import { useEffect, useRef, useState } from "preact/hooks";
import { waitClock } from "./wait.ts";

export const SLOW_MS = 1000;

// true once loading has held SLOW_MS, false again as soon as it ends
export function useSlow(loading: boolean): boolean {
  const since = useRef<number | null>(null);
  const [, redraw] = useState(0);
  const clock = waitClock();
  const now = clock.now();
  since.current = loading ? (since.current ?? now) : null;
  const at = since.current;
  const slow = at !== null && now - at >= SLOW_MS;
  useEffect(() => {
    if (at === null || slow) return;
    return clock.after(Math.max(0, at + SLOW_MS - clock.now()), () =>
      redraw((n) => n + 1),
    );
  }, [at, slow, clock]);
  return slow;
}
