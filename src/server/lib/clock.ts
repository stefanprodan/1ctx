// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Milliseconds since the epoch, as a port so a test can move time.

export type Clock = (() => number) & {
  sleep?: (ms: number) => Promise<void>;
};

export const wallClock: Clock = () => Date.now();

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type Sleep = { promise: Promise<void>; cancel: () => void };

// resolves after ms on the clock; the cancel clears a real timer, and a
// clock's own sleep is left to resolve unheard
export function sleep(clock: Clock, ms: number): Sleep {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise:
      clock.sleep?.(ms) ??
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

// false when the signal ended the wait
export async function sleepUnless(
  clock: Clock,
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (ms <= 0) return true;
  let stop = () => {};
  const aborted = new Promise<void>((resolve) => {
    stop = resolve;
    signal.addEventListener("abort", stop, { once: true });
  });
  // listening first, so an abort however early ends the wait
  const timer = sleep(clock, ms);
  try {
    await Promise.race([timer.promise, aborted]);
  } finally {
    timer.cancel();
    signal.removeEventListener("abort", stop);
  }
  return !signal.aborted;
}

// a cancel drops fire, so a sleep the clock cannot cancel never keeps
// what fire reaches alive
export function after(clock: Clock, ms: number, fire: () => void): () => void {
  let armed: (() => void) | null = fire;
  const timer = sleep(clock, ms);
  void timer.promise.then(() => armed?.());
  return () => {
    armed = null;
    timer.cancel();
  };
}
