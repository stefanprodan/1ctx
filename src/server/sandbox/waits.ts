// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Waits on the clock port, so a test moves them with its fake clock:
// a step bounded by a deadline, a call bounded on its own, and a wait
// for the leases to change.

import { after, type Clock, sleepUnless } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";

// the signal, aborted at the deadline too
export function bounded(
  clock: Clock,
  deadline: number,
  signal: AbortSignal,
  why: string,
): { signal: AbortSignal; dispose(): void } {
  const ctl = new AbortController();
  const cancel = after(clock, Math.max(0, deadline - clock()), () =>
    ctl.abort(new Error(why)),
  );
  return { signal: AbortSignal.any([signal, ctl.signal]), dispose: cancel };
}

// a call bounded by ms; null when it failed, logged unless quiet
export async function ask<T>(
  clock: Clock,
  log: Log,
  ms: number,
  call: (signal: AbortSignal) => Promise<T>,
  quiet = false,
): Promise<T | null> {
  const ctl = new AbortController();
  const cancel = after(clock, ms, () =>
    ctl.abort(new Error("gateway call timed out")),
  );
  try {
    return await call(ctl.signal);
  } catch (error) {
    if (!quiet) log.warn("sandbox gateway call failed", errorFields(error));
    return null;
  } finally {
    cancel();
  }
}

// false at the deadline, before the promise settled; a throw when the
// command was stopped
export async function within(
  clock: Clock,
  promise: Promise<void>,
  deadline: number,
  signal: AbortSignal,
): Promise<boolean> {
  const left = deadline - clock();
  if (left <= 0) return false;
  const stop = new AbortController();
  try {
    await Promise.race([
      promise,
      sleepUnless(clock, left, AbortSignal.any([signal, stop.signal])),
    ]);
  } finally {
    stop.abort();
  }
  signal.throwIfAborted();
  return clock() < deadline;
}

// what a command at the cap waits on: any release, delete or create
export class Changes {
  private readonly waiters = new Set<() => void>();
  // commands waiting now, which the warm pool leaves room for
  waiting = 0;

  constructor(private readonly clock: Clock) {}

  changed(): void {
    for (const wake of [...this.waiters]) wake();
  }

  // false at the deadline; a throw when the command was stopped
  async wait(deadline: number, signal: AbortSignal): Promise<boolean> {
    const left = deadline - this.clock();
    if (left <= 0) return false;
    this.waiting++;
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.waiters.add(wake);
    const stop = new AbortController();
    try {
      await Promise.race([
        woken,
        sleepUnless(this.clock, left, AbortSignal.any([signal, stop.signal])),
      ]);
    } finally {
      stop.abort();
      this.waiters.delete(wake);
      this.waiting--;
    }
    signal.throwIfAborted();
    return this.clock() < deadline;
  }
}
