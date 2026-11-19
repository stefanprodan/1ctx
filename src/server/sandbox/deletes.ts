// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The deletes of one manager's sandboxes, in the background: the delete,
// then the wait until the gateway forgets the name. One that fails is
// asked again a few times; one past its timeout is stuck and only its
// phase is asked after, never its delete.

import { after, type Clock, MINUTE_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { Book, Lease } from "./book.ts";
import type { Gateway, SandboxPhase } from "./gateway.ts";
import type { RecycleReason } from "./hold.ts";
import { mountsKey } from "./spec.ts";
import { type Cuts, STEP_MS } from "./sweep.ts";
import { ask } from "./waits.ts";

// a delete the gateway has not finished by then is stuck
export const DELETE_TIMEOUT_MS = 60_000;
// a stuck sandbox's phase is asked again this often, never its delete
export const STUCK_CHECK_MS = 5 * MINUTE_MS;
// a delete that failed, not one past its timeout, is asked again after
// this, then three and nine times this, then it is stuck
export const DELETE_RETRY_MS = 5_000;
export const DELETE_TRIES = 3;

export type DeletesDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  book: Book;
  cuts: Cuts;
  // shut down: no retry and no phase check
  closed(): boolean;
  // a record went, its delete observed
  forgot(): void;
  // a delete ended, either way
  ended(): void;
};

export class Deletes {
  constructor(private readonly deps: DeletesDeps) {}

  destroy(lease: Lease, reason: RecycleReason): void {
    if (lease.state === "deleting" || lease.state === "stuck") return;
    // a create cut short may still land after this delete
    if (lease.state === "creating") this.deps.cuts.mark(lease.name);
    lease.timer?.();
    lease.timer = null;
    this.deps.book.unlink(lease);
    lease.state = "deleting";
    this.deps.log.info("sandbox recycled", { sandbox: lease.name, reason });
    void this.delete(lease);
  }

  // a sandbox no lease uses, or a stuck one, deleted again
  adopt(name: string, phase: SandboxPhase): Promise<void> {
    const { book, clock } = this.deps;
    const lease =
      book.records.get(name) ?? book.add(name, null, mountsKey([]), clock());
    lease.timer?.();
    lease.timer = null;
    lease.phase = phase;
    lease.state = "deleting";
    lease.tries = 0;
    return this.delete(lease);
  }

  // the cache trees it mounted stay held until the gateway forgets it,
  // since a bind is not moved by a tree published again at the same path
  private async delete(lease: Lease): Promise<void> {
    const { clock, gateway } = this.deps;
    const ctl = new AbortController();
    const cancel = after(clock, DELETE_TIMEOUT_MS, () =>
      ctl.abort(new Error("delete timed out")),
    );
    try {
      await gateway.delete(lease.name, ctl.signal);
      await gateway.waitDeleted(lease.name, ctl.signal);
      this.forget(lease);
    } catch (error) {
      // a delete past its timeout is stuck; another failure, a blip,
      // is asked again a few times first
      const timedOut = ctl.signal.aborted;
      if (!timedOut && lease.tries < DELETE_TRIES - 1 && !this.deps.closed()) {
        const wait = DELETE_RETRY_MS * 3 ** lease.tries;
        lease.tries++;
        lease.timer = after(clock, wait, () => {
          lease.timer = null;
          void this.delete(lease);
        });
        return;
      }
      lease.state = "stuck";
      lease.evicted = false;
      this.deps.log.warn("sandbox delete stuck", {
        sandbox: lease.name,
        ...errorFields(error, false),
      });
      // kept, a drained manager's too, until the gateway forgets it: a
      // sweep that already ran would never see it again
      await this.stuck(lease);
    } finally {
      cancel();
    }
    this.deps.ended();
  }

  private forget(lease: Lease): void {
    this.deps.book.forget(lease);
    this.deps.forgot();
  }

  // a stuck sandbox's phase, never another delete: one the gateway can
  // no longer remove (a driver operation left pending) would only be
  // asked again forever
  private async stuck(lease: Lease): Promise<void> {
    if (this.deps.closed() || lease.state !== "stuck") return;
    const { clock, log, gateway } = this.deps;
    const phase = await ask(clock, log, STEP_MS, (signal) =>
      gateway.phase(lease.name, signal),
    );
    if (phase === "gone") {
      this.forget(lease);
      this.deps.ended();
      return;
    }
    if (phase !== null) lease.phase = phase;
    if (this.deps.closed()) return;
    lease.timer = after(clock, STUCK_CHECK_MS, () => {
      lease.timer = null;
      void this.stuck(lease);
    });
  }
}
