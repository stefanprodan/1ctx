// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The warm pool of one manager: sandboxes made ahead for a call without
// repositories, topped up in the background to sandboxWarm and cut back
// to it when the limit is lowered.

import { after, type Clock } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { SandboxCaps } from "../limits/index.ts";
import type { Book, Lease } from "./book.ts";
import type { Deletes } from "./deletes.ts";

// a warm sandbox's create, which no command's deadline bounds
export const WARM_CREATE_MS = 120_000;
// a failed warm create waits this long before the pool tries again
export const REFILL_BACKOFF_MS = 30_000;

export type PoolDeps = {
  clock: Clock;
  log: Log;
  limits(): SandboxCaps;
  book: Book;
  deletes: Deletes;
  // shut down or draining: nothing is made and a made one goes
  stopped(): boolean;
  // a refused image or a global policy: nothing is made
  blocked(): boolean;
  // every manager's sandboxes against the cap
  total(): number;
  // commands waiting for room, which the pool leaves it to
  waiting(): number;
  // a new lease for no workspace, made and recorded
  build(signal: AbortSignal): { lease: Lease; built: Promise<void> };
  changed(): void;
};

export class WarmPool {
  private backoff: (() => void) | null = null;

  constructor(private readonly deps: PoolDeps) {}

  // never past the cap and never while a command waits for room
  refill(): void {
    const { book, deletes } = this.deps;
    if (this.deps.stopped()) return;
    const caps = this.deps.limits();
    // a lowered sandboxWarm: the warm ones past it go
    for (let over = book.warm() - caps.sandboxWarm; over > 0; over--) {
      const extra = book.takeWarm();
      if (extra === null) break;
      deletes.destroy(extra, "settings");
    }
    if (this.backoff !== null || this.deps.blocked()) return;
    let warm = book.warm();
    while (
      warm < caps.sandboxWarm &&
      this.deps.total() < caps.sandboxesMax &&
      this.deps.waiting() === 0
    ) {
      warm++;
      void this.warm();
    }
  }

  stop(): void {
    this.backoff?.();
    this.backoff = null;
  }

  private async warm(): Promise<void> {
    const ctl = new AbortController();
    const cancel = after(this.deps.clock, WARM_CREATE_MS, () =>
      ctl.abort(new Error("warm create timed out")),
    );
    const { lease, built } = this.deps.build(ctl.signal);
    try {
      await built;
      // a sandboxWarm lowered while it was made: the trim above could
      // not take it then
      const over = this.deps.book.warm() > this.deps.limits().sandboxWarm;
      if (lease.doomed || this.deps.stopped() || over) {
        this.deps.deletes.destroy(lease, "settings");
      } else lease.state = "warm";
    } catch (error) {
      this.deps.deletes.destroy(lease, "failed");
      this.deps.log.warn("sandbox create failed", {
        sandbox: lease.name,
        ...errorFields(error),
      });
      if (!this.deps.stopped() && this.backoff === null) {
        this.backoff = after(this.deps.clock, REFILL_BACKOFF_MS, () => {
          this.backoff = null;
          this.refill();
        });
      }
    } finally {
      cancel();
    }
    this.deps.changed();
  }
}
