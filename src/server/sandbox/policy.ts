// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A gateway-global policy replaces each sandbox's own, so while one is
// set no command runs. A sweep sees it; a refused command asks again at
// most every RECHECK_MS, so an admin removing it unblocks commands with
// no restart of the gateway or of 1ctx.

import { type Clock, sleepUnless } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import type { Gateway } from "./gateway.ts";
import { STEP_MS } from "./sweep.ts";
import { ask } from "./waits.ts";

export const POLICY_RECHECK_MS = 10_000;

export type PolicyGateDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  // the policy went: what waited on it may start
  cleared(): void;
};

export class PolicyGate {
  blocked = false;
  private askedAt = Number.NEGATIVE_INFINITY;
  private asking: Promise<void> | null = null;

  constructor(private readonly deps: PolicyGateDeps) {}

  // what a sweep or a command's check found; null when the gateway
  // could not say
  seen(policy: boolean | null): void {
    if (policy === null || policy === this.blocked) return;
    this.blocked = policy;
    if (policy) {
      this.deps.log.warn("sandbox gateway has a global policy");
      return;
    }
    this.deps.log.info("sandbox gateway global policy removed");
    this.deps.cleared();
  }

  // false while the policy stays; one ask serves every waiting command
  async open(deadline: number, signal: AbortSignal): Promise<boolean> {
    if (!this.blocked) return true;
    const { clock, log, gateway } = this.deps;
    if (this.asking === null && clock() - this.askedAt >= POLICY_RECHECK_MS) {
      this.askedAt = clock();
      this.asking = ask(clock, log, STEP_MS, (step) =>
        gateway.globalPolicy(step),
      )
        .then((policy) => {
          if (policy === false) this.seen(false);
        })
        .finally(() => {
          this.asking = null;
        });
    }
    if (this.asking !== null) {
      // the command's own deadline and stop end its wait, not the ask
      const stop = new AbortController();
      try {
        await Promise.race([
          this.asking,
          sleepUnless(
            clock,
            Math.max(0, deadline - clock()),
            AbortSignal.any([signal, stop.signal]),
          ),
        ]);
      } finally {
        stop.abort();
      }
    }
    signal.throwIfAborted();
    return !this.blocked;
  }
}
