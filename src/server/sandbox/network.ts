// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A held sandbox's network made what the command's send allows, before
// the command: the providers its credentials need, attached, then bound
// by the policy, then waited for until OpenShell reports both applied.
// What can only be undone by a new sandbox (a credential gone, a key
// rotated, the network turned off) recycles instead. A provider's key is
// compared by its hash in memory, never stored or logged.

import type { SandboxNet } from "../../shared/sandbox-net.ts";
import type { ShellCall } from "../bash/index.ts";
import { after, type Clock, sleep, sleepUnless } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { DELETE_RETRY_MS, DELETE_TRIES } from "./deletes.ts";
import type { Gateway } from "./gateway.ts";
import type { SandboxHold } from "./hold.ts";
import {
  type Attach,
  freshState,
  type NetState,
  planNetwork,
  stale,
} from "./netpolicy.ts";
import { INSTANCE_LABEL, POLICY } from "./spec.ts";
import { STEP_MS } from "./sweep.ts";
import { ask, bounded } from "./waits.ts";

// the promise, or the signal's reason once it aborts first
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", stop);
    });
  });
}

export const GLOBAL_POLICY_REFUSAL =
  "the sandbox gateway has a global policy set, which replaces each sandbox's own. An admin must remove it";

const NO_NET: SandboxNet = { mode: "off", hosts: [] };

// a provider past this after its bind is not coming
export const READY_MS = 10_000;
const READY_POLL_MS = 50;

export type NetworkDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  instanceId: string;
  // the sandbox's network setting, read at each command; off without it
  net?(): SandboxNet;
  // by provider name and by profile, shared by every manager of the
  // instance, so an attach and a delete of one never overlap
  locks?: Map<string, Promise<unknown>>;
  // another manager's lease still uses the profile, or the provider
  profileElsewhere?(id: string): boolean;
  providerElsewhere?(name: string): boolean;
  // what a command's check found: a global policy set, or none
  globalPolicy?(set: boolean): void;
  // shut down: a failed provider delete is not asked again
  closed?(): boolean;
};

export class Network {
  // provider name: the key hash it holds now and its profile
  private readonly providers = new Map<
    string,
    { hash: string; profile: string }
  >();
  private readonly imported = new Set<string>();
  // provider name: the sandboxes it is attached to
  private readonly users = new Map<string, Set<string>>();
  // provider name: its profile, from its first attach until its drop,
  // so a profile is kept while an attach of it is in flight
  private readonly profileOf = new Map<string, string>();
  private readonly locks: Map<string, Promise<unknown>>;
  // drops not yet ended, which a drain waits for
  private readonly dropping = new Set<Promise<void>>();

  constructor(private readonly deps: NetworkDeps) {
    this.locks = deps.locks ?? new Map();
  }

  // ready: the sandbox's network is the send's. recycled: the hold went,
  // so the caller leases again. busy: the deadline passed first
  async configure(
    hold: SandboxHold,
    call: ShellCall,
    deadline: number,
    signal: AbortSignal,
  ): Promise<"ready" | "recycled" | "busy"> {
    const state = (hold.network.value as NetState | null) ?? freshState();
    hold.network.value = state;
    // a send without web access has no network here either
    const net = (call.network ? this.deps.net?.() : undefined) ?? NO_NET;
    const plan = planNetwork(call, net, this.deps.instanceId);
    const why = stale(state, plan);
    if (why !== null) {
      hold.recycle(why);
      return "recycled";
    }
    const step = bounded(
      this.deps.clock,
      deadline,
      signal,
      "the command's time ran out",
    );
    const fresh = plan.attach.filter((one) => !state.attached.has(one.name));
    try {
      // a global policy set since start replaces the sandbox's own
      const global = await this.deps.gateway.globalPolicy(step.signal);
      this.deps.globalPolicy?.(global);
      if (global) {
        hold.release();
        throw new Error(GLOBAL_POLICY_REFUSAL);
      }
      for (const one of fresh) {
        await this.attach(hold.sandbox, one, step.signal);
        state.attached.set(one.name, {
          provider: one.provider,
          hash: one.hash,
          prefix: one.prefix,
        });
      }
      if (plan.key !== state.key) {
        // unknown until loaded: a failed load leaves it neither
        state.key = "";
        await this.deps.gateway.setPolicy(
          hold.sandbox,
          POLICY,
          plan.network,
          step.signal,
        );
        state.key = plan.key;
      }
      state.mode = plan.mode;
      for (const one of fresh)
        await this.ready(hold.sandbox, one.provider, step.signal);
    } catch (error) {
      if (error instanceof Error && error.message === GLOBAL_POLICY_REFUSAL)
        throw error;
      // what the gateway holds is unknown now: asked again next time.
      // The sandbox goes once no command holds it, so commands beside
      // this one run on
      hold.retire("failed");
      for (const one of fresh) {
        this.imported.delete(one.profile.id);
        this.providers.delete(one.provider);
      }
      signal.throwIfAborted();
      if (step.signal.aborted) return "busy";
      this.deps.log.warn("sandbox network failed", {
        sandbox: hold.sandbox,
        ...errorFields(error),
      });
      throw new Error("the sandbox network could not be set up");
    } finally {
      step.dispose();
    }
    // each send's first command names what was left out
    const noticed = `${call.sendId}\0${plan.notice}`;
    hold.notice = state.noticed === noticed ? "" : plan.notice;
    state.noticed = noticed;
    if (fresh.length > 0)
      this.deps.log.info("sandbox network set", {
        sandbox: hold.sandbox,
        credentials: plan.attach.length,
        attached: fresh.length,
      });
    return "ready";
  }

  // the provider holds the key, and is attached; withheld until bound
  private async attach(
    sandbox: string,
    one: Attach,
    signal: AbortSignal,
  ): Promise<void> {
    let users = this.users.get(one.provider);
    if (users === undefined) {
      users = new Set();
      this.users.set(one.provider, users);
    }
    users.add(sandbox);
    this.profileOf.set(one.provider, one.profile.id);
    await this.locked(one.provider, signal, async () => {
      const { gateway } = this.deps;
      const { profile } = one;
      // after any delete of the profile that began before
      await this.locked(profileLock(profile.id), signal, async () => {
        if (this.imported.has(profile.id)) return;
        await gateway.providers.importProfile(
          {
            id: profile.id,
            env: profile.env,
            style: profile.style,
            header: profile.header,
            annotations: { [INSTANCE_LABEL]: this.deps.instanceId },
          },
          signal,
        );
        this.imported.add(profile.id);
      });
      if (this.providers.get(one.provider)?.hash !== one.hash) {
        // unknown until the put lands
        this.providers.delete(one.provider);
        await gateway.providers.put(
          {
            name: one.provider,
            profile: profile.id,
            env: profile.env,
            key: one.key,
            labels: { [INSTANCE_LABEL]: this.deps.instanceId },
          },
          signal,
        );
        this.providers.set(one.provider, {
          hash: one.hash,
          profile: profile.id,
        });
      }
      await gateway.providers.attach(sandbox, one.provider, signal);
    });
  }

  // after the bind: the policy is loaded, so the provider's own report
  private async ready(
    sandbox: string,
    provider: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { clock, gateway } = this.deps;
    const ctl = new AbortController();
    const cancel = after(clock, READY_MS, () =>
      ctl.abort(new Error("the credential was not applied in time")),
    );
    const both = AbortSignal.any([signal, ctl.signal]);
    try {
      for (;;) {
        both.throwIfAborted();
        const state = await gateway.providers.state(sandbox, provider, both);
        if (state === "ready") return;
        if (state === "failed" || state === "revoked")
          throw new Error(`the credential's provider is ${state}`);
        await sleepUnless(clock, READY_POLL_MS, both);
      }
    } finally {
      cancel();
    }
  }

  // run after every earlier holder of the name. With a signal the wait
  // ends at its abort, since an attach or a delete ahead may outlast the
  // command's deadline, and a run whose signal went never starts
  private locked<T>(
    name: string,
    signal: AbortSignal | null,
    run: () => Promise<T>,
  ): Promise<T> {
    const before = this.locks.get(name) ?? Promise.resolve();
    const next = before
      .catch(() => {})
      .then(() => {
        signal?.throwIfAborted();
        return run();
      });
    this.locks.set(name, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.locks.get(name) === next) this.locks.delete(name);
      });
    return signal === null ? next : untilAborted(next, signal);
  }

  // a sandbox's delete was observed: a provider attached to no other
  // goes, then its profile when no provider uses it
  forgot(sandbox: string): void {
    for (const [provider, users] of [...this.users]) {
      if (!users.delete(sandbox) || users.size > 0) continue;
      this.users.delete(provider);
      const dropped = this.dropRetried(provider)
        .catch(() => {})
        .finally(() => this.dropping.delete(dropped));
      this.dropping.add(dropped);
    }
  }

  // every drop begun so far ended
  async dropped(): Promise<void> {
    while (this.dropping.size > 0) await Promise.all([...this.dropping]);
  }

  // a failed delete, a blip, is asked again as a sandbox's is, each
  // try under the lock and the waits outside it
  private async dropRetried(provider: string): Promise<void> {
    const profile = this.profileOf.get(provider);
    for (let tries = 0; ; tries++) {
      const done = await this.locked(provider, null, () =>
        this.drop(provider, profile),
      );
      if (done || tries >= DELETE_TRIES - 1) return;
      if (this.deps.closed?.()) return;
      await sleep(this.deps.clock, DELETE_RETRY_MS * 3 ** tries).promise;
      if (this.deps.closed?.()) return;
    }
  }

  // false when the provider's delete failed
  private async drop(
    provider: string,
    profile: string | undefined,
  ): Promise<boolean> {
    // attached again while this waited for the lock
    if ((this.users.get(provider)?.size ?? 0) > 0) return true;
    const { clock, log, gateway } = this.deps;
    this.profileOf.delete(provider);
    this.providers.delete(provider);
    // a replacement manager attached it since: its delete is that one's
    if (this.deps.providerElsewhere?.(provider)) return true;
    const done = await ask(clock, log, STEP_MS, async (signal) => {
      await gateway.providers.delete(provider, signal);
      return true;
    });
    if (done === null) return false;
    if (profile === undefined) return true;
    await this.locked(profileLock(profile), null, async () => {
      // another provider of it, attached or attaching, here or elsewhere
      if (this.holdsProfile(profile)) return;
      this.imported.delete(profile);
      if (this.deps.profileElsewhere?.(profile)) return;
      await ask(clock, log, STEP_MS, async (signal) => {
        await gateway.providers.deleteProfile(profile, signal);
        return true;
      });
    });
    return true;
  }

  // a sweep's delete of a provider no lease used when it listed: asked
  // again under the attach's lock, since one may have taken it since.
  // true when it went
  sweep(
    provider: string,
    foreign: (name: string) => boolean,
  ): Promise<boolean> {
    return this.locked(provider, null, async () => {
      if (this.holds(provider) || foreign(provider)) return false;
      const { clock, log, gateway } = this.deps;
      this.providers.delete(provider);
      const done = await ask(clock, log, STEP_MS, async (signal) => {
        await gateway.providers.delete(provider, signal);
        return true;
      });
      return done === true;
    });
  }

  // a sweep's delete of a profile, asked again under the import's lock
  sweepProfile(id: string): Promise<void> {
    return this.locked(profileLock(id), null, async () => {
      if (this.holdsProfile(id) || this.deps.profileElsewhere?.(id)) return;
      this.imported.delete(id);
      const { clock, log, gateway } = this.deps;
      await ask(clock, log, STEP_MS, async (signal) => {
        await gateway.providers.deleteProfile(id, signal);
        return true;
      });
    });
  }

  // a provider or profile a lease still uses, which no sweep deletes
  holds(provider: string): boolean {
    return (this.users.get(provider)?.size ?? 0) > 0;
  }

  holdsProfile(id: string): boolean {
    for (const profile of this.profileOf.values()) {
      if (profile === id) return true;
    }
    return false;
  }
}

const profileLock = (id: string) => `profile:${id}`;
