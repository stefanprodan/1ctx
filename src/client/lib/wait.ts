// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How long a waiting body shows. It fades in only after REVEAL_MS (a
// CSS delay on .bones-wait), so a fast answer draws nothing new; once
// shown it stays SHOW_MS, so an answer landing just after the reveal
// never flashes the bones away.

import { useEffect, useRef, useState } from "preact/hooks";
import { browserClock, type DayClock } from "./now.ts";

export const REVEAL_MS = 200;
export const SHOW_MS = 300;

let clock: DayClock = browserClock;

// the clock the waits read, for useSlow beside them
export function waitClock(): DayClock {
  return clock;
}

// the tests' fake clock; returns the one it replaces
export function setWaitClock(next: DayClock): DayClock {
  const was = clock;
  clock = next;
  return was;
}

export type Hold = {
  // when the wait started, null while nothing waits
  since: number | null;
  // the waiting body stays drawn until then, after the load ended
  until: number;
};

export const idleHold: Hold = { since: null, until: 0 };

// one step of the hold at now: whether the waiting body is drawn, and
// the hold to keep for the next step
export function stepHold(
  hold: Hold,
  loading: boolean,
  now: number,
): { hold: Hold; waiting: boolean } {
  if (loading) {
    if (hold.since !== null) return { hold, waiting: true };
    // a load that starts again while the bones are still held finds
    // them shown already
    const since = now < hold.until ? now - REVEAL_MS : now;
    return { hold: { since, until: 0 }, waiting: true };
  }
  if (hold.since !== null) {
    const shown = now - hold.since >= REVEAL_MS;
    const until = shown ? hold.since + REVEAL_MS + SHOW_MS : 0;
    return { hold: { since: null, until }, waiting: now < until };
  }
  return { hold, waiting: now < hold.until };
}

// whether to draw the waiting body: while loading, and SHOW_MS past
// the reveal once it showed
export function useWaiting(loading: boolean): boolean {
  const hold = useRef<Hold>(idleHold);
  const [, redraw] = useState(0);
  const now = clock.now();
  const step = stepHold(hold.current, loading, now);
  hold.current = step.hold;
  const held = !loading && step.waiting;
  const until = step.hold.until;
  useEffect(() => {
    if (!held) return;
    return clock.after(Math.max(0, until - clock.now()), () =>
      redraw((n) => n + 1),
    );
  }, [held, until]);
  return step.waiting;
}
