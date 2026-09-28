// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PollDriver } from "../../src/client/lib/poll.ts";

export function pollTab(period: number) {
  let hidden = false;
  let now = 0;
  const heard = new Set<() => void>();
  const ticks = new Map<() => void, { ms: number; next: number }>();
  const tab: PollDriver = {
    hidden: () => hidden,
    listen(change) {
      heard.add(change);
      return () => heard.delete(change);
    },
    now: () => now,
    every(ms, tick) {
      ticks.set(tick, { ms, next: now + ms });
      return () => ticks.delete(tick);
    },
  };
  return {
    tab,
    set(state: "visible" | "hidden") {
      hidden = state === "hidden";
      for (const change of [...heard]) change();
    },
    tick() {
      now += period;
      for (const [tick, timer] of [...ticks]) {
        if (now < timer.next) continue;
        timer.next = now + timer.ms;
        tick();
      }
    },
    timers: () => ticks.size,
    listeners: () => heard.size,
  };
}
