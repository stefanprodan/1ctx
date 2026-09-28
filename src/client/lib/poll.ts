// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What drives a page's poll: whether the browser tab is seen, a way
// to hear that change, the time and a repeating timer, so a test can
// drive them.

export type PollDriver = {
  hidden(): boolean;
  listen(change: () => void): () => void;
  now(): number;
  every(ms: number, tick: () => void): () => void;
};

export const browserTab: PollDriver = {
  hidden: () => document.visibilityState === "hidden",
  listen(change) {
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  },
  now: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

// Calls tick every ms while the tab is seen, until the stop it answers.
// The page has just loaded, so the first call waits a whole period; a
// tab seen again past one calls at once.
export function pollWhileSeen(
  ms: number,
  tick: () => void,
  tab: PollDriver = browserTab,
): () => void {
  let stopTimer: (() => void) | null = null;
  let calledAt = tab.now();
  const call = () => {
    calledAt = tab.now();
    tick();
  };
  const change = () => {
    stopTimer?.();
    stopTimer = null;
    if (tab.hidden()) return;
    if (tab.now() - calledAt >= ms) call();
    stopTimer = tab.every(ms, call);
  };
  const unlisten = tab.listen(change);
  change();
  return () => {
    unlisten();
    stopTimer?.();
  };
}
