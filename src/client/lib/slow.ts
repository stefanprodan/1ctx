// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether a wait has gone on long enough to say so in words. Bones say
// a load runs; a word drawn at once beside them would flash on every
// fast answer, so the words wait SLOW_MS, on the waits' own clock.

import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { HandOver, REVEAL_MS, waitClock } from "./wait.ts";

export const SLOW_MS = 1000;

// A wait one page hands to the next under a name: a path link's page
// to the file's, a file's waiting page to its deleted page. The reader
// sees one wait, so its start carries over and the words do not go
// back to waiting a second. A name left behind longer than CARRY_MS is
// a wait of another visit.
export const CARRY_MS = REVEAL_MS;

type Carried = { since: number; left: number | null };
const carried = new Map<string, Carried>();

function carriedSince(key: string, now: number): number | null {
  for (const [name, held] of carried) {
    if (held.left !== null && now - held.left > CARRY_MS) carried.delete(name);
  }
  return carried.get(key)?.since ?? null;
}

// the tests' reset, so a carried wait never leaks into the next test
export function dropCarried(): void {
  carried.clear();
}

export type Waited = {
  // true once loading has held SLOW_MS
  slow: boolean;
  // when the wait started, a carried one included; null while nothing
  // waits
  since: number | null;
};

// how long loading has held, from the start a carry names when one is
// given and still fresh, else the shell's wait it goes on with
export function useWaited(loading: boolean, carry?: string): Waited {
  const since = useRef<number | null>(null);
  const handed = useContext(HandOver);
  const [, redraw] = useState(0);
  const clock = waitClock();
  const now = clock.now();
  if (loading) {
    since.current ??=
      (carry === undefined ? null : carriedSince(carry, now)) ?? handed ?? now;
    if (carry !== undefined) {
      carried.set(carry, { since: since.current, left: null });
    }
  } else {
    since.current = null;
    if (carry !== undefined) carried.delete(carry);
  }
  const at = since.current;
  const slow = at !== null && now - at >= SLOW_MS;
  useEffect(() => {
    if (at === null || slow) return;
    return clock.after(Math.max(0, at + SLOW_MS - clock.now()), () =>
      redraw((n) => n + 1),
    );
  }, [at, slow, clock]);
  // a page that goes while it waits leaves its start for the next one
  useEffect(() => {
    if (carry === undefined) return;
    return () => {
      const held = carried.get(carry);
      if (held !== undefined && held.left === null) {
        held.left = waitClock().now();
      }
    };
  }, [carry]);
  return { slow, since: at };
}

// true once loading has held SLOW_MS, false again as soon as it ends
export function useSlow(loading: boolean): boolean {
  return useWaited(loading).slow;
}
