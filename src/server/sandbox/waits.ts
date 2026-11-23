// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Waits on the clock port, so a test moves them with its fake clock:
// a step bounded by a deadline, a call bounded on its own, a wait for
// the leases to change, and a gate that holds commands until it opens.

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
  // those of them waiting at the cap, each owed one delete
  capped = 0;

  constructor(private readonly clock: Clock) {}

  changed(): void {
    for (const wake of [...this.waiters]) wake();
  }

  // false at the deadline; a throw when the command was stopped
  async wait(
    deadline: number,
    signal: AbortSignal,
    capped = false,
  ): Promise<boolean> {
    const left = deadline - this.clock();
    if (left <= 0) return false;
    this.waiting++;
    if (capped) this.capped++;
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
      if (capped) this.capped--;
    }
    signal.throwIfAborted();
    return this.clock() < deadline;
  }
}

// shut until opened; a wait ends at the opening or at the deadline
export class Gate {
  private opened: (() => void) | null = null;
  private promise: Promise<void> | null = null;

  get shut(): boolean {
    return this.promise !== null;
  }

  close(): void {
    this.promise ??= new Promise<void>((resolve) => {
      this.opened = resolve;
    });
  }

  open(): void {
    this.opened?.();
    this.opened = null;
    this.promise = null;
  }

  // false at the deadline; a throw when the command was stopped
  pass(clock: Clock, deadline: number, signal: AbortSignal): Promise<boolean> {
    if (this.promise === null) return Promise.resolve(true);
    return within(clock, this.promise, deadline, signal);
  }
}

// a close or a drain: every command held at the gate, for a seat or at
// the cap meets it now, since no sweep or release may come after
export function wakeAll(gate: Gate, ...changes: Changes[]): void {
  gate.open();
  for (const each of changes) each.changed();
}
