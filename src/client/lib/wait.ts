// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How long a waiting body shows. It fades in only after REVEAL_MS (a
// CSS delay on .bones-wait), so a fast answer draws nothing new; once
// shown it stays SHOW_MS, so an answer landing just after the reveal
// never flashes the bones away.

import { createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
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
// the hold to keep for the next step. from is the start of a wait this
// one goes on with (HandOver), so bones it shows already count as
// shown.
export function stepHold(
  hold: Hold,
  loading: boolean,
  now: number,
  from: number | null = null,
): { hold: Hold; waiting: boolean } {
  if (loading) {
    if (hold.since !== null) return { hold, waiting: true };
    // a load that starts again while the bones are still held finds
    // them shown already
    const own = now < hold.until ? now - REVEAL_MS : now;
    const since = from === null ? own : Math.min(own, from);
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
  const step = stepHold(hold.current, loading, now, useContext(HandOver));
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

// The shell's wait: for me, then for the view's code. Each hand-over
// (the shell's shape to the lazy view's, that to the page's own) mounts
// the body anew, so its bones would replay their reveal and blink. The
// shell puts --waited on its main (bones-waited), so bones drawn anew
// start as far into the reveal as the wait has gone, and provides the
// wait's start: a wait that begins under it goes on with that start,
// its hold, its own --waited and its slow words counted from there.
export const HandOver = createContext<number | null>(null);

// Past its end the shell keeps the wait this long on the address it
// ended on: a bone drawn under --waited is that far into its reveal, so
// it must have run the whole reveal (two REVEAL_MS: its delay and its
// fade) before dropping the class would put it back to its start.
export const HANDED_MS = REVEAL_MS + SHOW_MS;

export type HandedWait = {
  // the wait's start, for HandOver; null once nothing carries it
  since: number | null;
  // how far it has gone, for --waited on the shell's main; null before
  // REVEAL_MS, since a --waited that grows under bones already drawn
  // moves their reveal earlier, and before REVEAL_MS that is too soon
  waited: number | null;
};

export function useHandOver(waiting: boolean, at: string): HandedWait {
  const since = useRef<number | null>(null);
  const ended = useRef<{ since: number; end: number; at: string } | null>(null);
  const [, redraw] = useState(0);
  const now = clock.now();
  if (waiting) {
    since.current ??= now;
    ended.current = null;
  } else if (since.current !== null) {
    ended.current = { since: since.current, end: now, at };
    since.current = null;
  }
  const kept = ended.current;
  const holding = kept !== null && kept.at === at && now < kept.end + HANDED_MS;
  const end = kept?.end ?? 0;
  useEffect(() => {
    if (!holding) return;
    return clock.after(Math.max(0, end + HANDED_MS - clock.now()), () =>
      redraw((n) => n + 1),
    );
  }, [holding, end]);
  const start = since.current ?? (holding && kept !== null ? kept.since : null);
  const gone = start === null ? 0 : now - start;
  return { since: start, waited: gone >= REVEAL_MS ? gone : null };
}
