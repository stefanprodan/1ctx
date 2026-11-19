// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A manager's sweeps (sweep.ts does one): at start, after a gateway
// restart, and again at the first probe that answers after one that
// could not list. Each takes what the gateway runs under the instance's
// label that no lease of any manager holds.

import type { Book, Lease } from "./book.ts";
import type { Deletes } from "./deletes.ts";
import type { RecycleReason } from "./hold.ts";
import type { Network } from "./network.ts";
import type { PolicyGate } from "./policy.ts";
import type { WarmPool } from "./pool.ts";
import { type SweepDeps, sweepLabelled } from "./sweep.ts";
import type { Gate } from "./waits.ts";
import type { Watch } from "./watch.ts";

export type SweeperDeps = Pick<
  SweepDeps,
  "clock" | "log" | "gateway" | "instanceId"
> & {
  book: Book;
  net: Network;
  deletes: Deletes;
  policy: PolicyGate;
  pool: WarmPool;
  watch: Watch;
  // shut from start until a sweep recorded what an earlier run left
  starting: Gate;
  // every other manager, whose holds no sweep of this one takes
  others(): readonly {
    holds(name: string): boolean;
    holdsProvider(name: string): boolean;
  }[];
  remove(lease: Lease, reason: RecycleReason): void;
  // a sweep listed every kind: what an earlier run left is known
  listed?(): void;
};

export class Sweeper {
  constructor(private readonly deps: SweeperDeps) {}

  // at start: what an earlier run left, then the pool and the probe. A
  // sweep that could not list keeps the gate shut and the pool empty
  // until one that can, which the next probe that answers runs
  async start(): Promise<void> {
    const { starting, pool, watch } = this.deps;
    starting.close();
    try {
      await this.sweep("start");
    } catch (error) {
      starting.open();
      throw error;
    }
    pool.refill();
    watch.arm();
  }

  // every lease dropped and its sandbox deleted, then what the gateway
  // still lists under our label, stuck ones asked to delete again
  async restarted(): Promise<void> {
    const leases = this.deps.book.live();
    this.deps.log.warn("sandbox gateway restarted", { leases: leases.length });
    for (const lease of leases) this.deps.remove(lease, "restart");
    await this.sweep("restart");
    this.deps.pool.refill();
  }

  async sweep(when: "start" | "restart" | "again"): Promise<void> {
    const { book, net, deletes, starting, watch, policy } = this.deps;
    const others = () => this.deps.others();
    const { globalPolicy, listed } = await sweepLabelled(
      {
        ...this.deps,
        held: (name) =>
          book.holds(name) || others().some((other) => other.holds(name)),
        dropProvider: (name) =>
          net.sweep(name, (provider) =>
            others().some((other) => other.holdsProvider(provider)),
          ),
        dropProfile: (id) => net.sweepProfile(id),
        adopt: (name, phase) => deletes.adopt(name, phase),
        counted: () => starting.open(),
      },
      when,
    );
    // a sweep that could not list runs again at the next good probe
    if (listed) this.deps.listed?.();
    else watch.sweepAgain();
    policy.seen(globalPolicy);
  }
}
