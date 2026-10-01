// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The clock a view's "2m ago" words read, moved every ms; null holds it
// still, for a view whose words stop moving. A view whose words name
// the day, today or tomorrow, moves at each midnight instead.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

export function useNow(ms: number | null): number {
  const now = useSignal(Date.now());
  useEffect(() => {
    if (ms === null) return;
    const timer = setInterval(() => {
      now.value = Date.now();
    }, ms);
    return () => clearInterval(timer);
  }, [ms, now]);
  return now.value;
}

export type DayClock = {
  now(): number;
  after(ms: number, fire: () => void): () => void;
};

const browserClock: DayClock = {
  now: () => Date.now(),
  after(ms, fire) {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

const DAY_PARTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
};

// the first moment of the next calendar day in tz, found by the hour and
// then to the millisecond, since a zone's offset or a daylight change
// can move midnight off the hour
export function nextDayAt(now: number, tz: string): number {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", { ...DAY_PARTS, timeZone: tz });
  } catch {
    format = new Intl.DateTimeFormat("en-GB", DAY_PARTS);
  }
  const today = format.format(now);
  let before = now;
  let after = now + 3_600_000;
  while (format.format(after) === today) {
    before = after;
    after += 3_600_000;
  }
  while (after - before > 1) {
    const mid = Math.floor((before + after) / 2);
    if (format.format(mid) === today) before = mid;
    else after = mid;
  }
  return after;
}

// one timer to the next midnight in tz, armed again after each turn
export function onDayTurn(
  tz: string,
  turn: () => void,
  clock: DayClock = browserClock,
): () => void {
  let stop = () => {};
  const arm = () => {
    const now = clock.now();
    stop = clock.after(nextDayAt(now, tz) - now, () => {
      turn();
      arm();
    });
  };
  arm();
  return () => stop();
}

// draws the view again when the day in tz turns
export function useDayTurn(tz: string): number {
  const turns = useSignal(0);
  useEffect(
    () =>
      onDayTurn(tz, () => {
        turns.value++;
      }),
    [tz, turns],
  );
  return turns.value;
}
