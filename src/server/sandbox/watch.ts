// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The probe of one gateway: a list under the instance label, every
// HEALTH_MS and whenever an exec saw a sandbox fail. A list that fails
// marks the gateway lost and the next that answers is a restart, since
// a crashed gateway comes back with every sandbox in error; every ready
// sandbox in error says the same even when no probe saw it down.

import { after, type Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { Lease } from "./book.ts";
import type { Gateway, SandboxInfo } from "./gateway.ts";
import { INSTANCE_LABEL } from "./spec.ts";
import { STEP_MS } from "./sweep.ts";
import { ask } from "./waits.ts";

// how often the gateway's sandboxes are listed while the shell is on
export const HEALTH_MS = 30_000;

export type WatchDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  instanceId: string;
  // the leases that should have a running sandbox
  live(): Lease[];
  // the book's order now; a lease ready after it may not be listed yet
  mark(): number;
  gone(lease: Lease): void;
  restarted(): Promise<void>;
  // what the list found, for the creates a signal cut
  reap(found: SandboxInfo[]): void;
};

// which leases lost their sandbox: those ready before the list began,
// listed in error or not listed at all. A restart when every ready one,
// two at least, is in error: one sandbox failing alone is that one's
export function judge(
  leases: Lease[],
  found: SandboxInfo[],
  since: number,
): { restart: boolean; gone: Lease[] } {
  const phases = new Map(found.map((info) => [info.name, info.phase]));
  const gone: Lease[] = [];
  let ready = 0;
  let errors = 0;
  for (const lease of leases) {
    if (lease.ready === 0 || lease.ready > since) continue;
    ready++;
    const phase = phases.get(lease.name) ?? "gone";
    lease.phase = phase;
    if (phase === "error") errors++;
    if (phase === "error" || phase === "gone") gone.push(lease);
  }
  return ready >= 2 && errors === ready
    ? { restart: true, gone: [] }
    : { restart: false, gone };
}

export class Watch {
  private lost = false;
  private timer: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly deps: WatchDeps) {}

  // a sweep that could not list: the next probe that answers runs it
  markLost(): void {
    this.lost = true;
  }

  arm(): void {
    if (this.closed) return;
    this.timer = after(this.deps.clock, HEALTH_MS, () => {
      this.timer = null;
      void this.check().finally(() => this.arm());
    });
  }

  // one probe at a time; a second asker waits for the running one
  check(): Promise<void> {
    this.running ??= this.once()
      .catch((error) => {
        this.deps.log.warn("sandbox probe failed", errorFields(error));
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  close(): void {
    this.closed = true;
    this.timer?.();
  }

  private async once(): Promise<void> {
    if (this.closed) return;
    const since = this.deps.mark();
    const labels = { [INSTANCE_LABEL]: this.deps.instanceId };
    const found = await ask(
      this.deps.clock,
      this.deps.log,
      STEP_MS,
      (signal) => this.deps.gateway.list(labels, signal),
      true,
    );
    if (found === null) {
      if (!this.lost) this.deps.log.warn("sandbox gateway lost");
      this.lost = true;
      return;
    }
    if (this.lost) {
      this.lost = false;
      return this.deps.restarted();
    }
    this.deps.reap(found);
    const verdict = judge(this.deps.live(), found, since);
    if (verdict.restart) return this.deps.restarted();
    for (const lease of verdict.gone) this.deps.gone(lease);
  }
}
