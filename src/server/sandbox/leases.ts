// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandboxes of one gateway, by workspace. A sandbox is a cache of
// the rows: any of them may be deleted between two commands and made
// again, so every doubt (a mismatch, a clear, a lost gateway) deletes
// rather than repairs. Deletes run in the background and never block a
// command; one that does not finish is kept as stuck, never retried.

import type { LeaseRow } from "../../shared/contracts/sandbox.ts";
import type { ShellCall, ShellRepo } from "../bash/index.ts";
import { after, type Clock, MINUTE_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { KnowledgeCaps, SandboxCaps } from "../limits/index.ts";
import { Book, type Lease } from "./book.ts";
import type { Gateway, SandboxPhase } from "./gateway.ts";
import type { RecycleReason, SandboxHold } from "./hold.ts";
import { readKeepAlive } from "./keepalive.ts";
import { createSpec, mountsKey, sandboxName } from "./spec.ts";
import { Cuts, STEP_MS, sweepLabelled } from "./sweep.ts";
import { ask, bounded, Changes } from "./waits.ts";
import { Watch } from "./watch.ts";

export type { RecycleReason, SandboxHold } from "./hold.ts";

// a delete the gateway has not finished by then is stuck
export const DELETE_TIMEOUT_MS = 60_000;
// a warm sandbox's create, which no command's deadline bounds
export const WARM_CREATE_MS = 120_000;
// a failed warm create waits this long before the pool tries again
export const REFILL_BACKOFF_MS = 30_000;
// a stuck sandbox's phase is asked again this often, never its delete
export const STUCK_CHECK_MS = 5 * MINUTE_MS;
// a delete that failed, not one past its timeout, is asked again after
// this, then three and nine times this, then it is stuck
export const DELETE_RETRY_MS = 5_000;
const DELETE_TRIES = 3;

export const GLOBAL_POLICY_REFUSAL =
  "the sandbox gateway has a global policy set, which would replace each sandbox's own; an admin must remove it";

export type LeasesDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  instanceId: string;
  image: string;
  limits(): KnowledgeCaps & SandboxCaps;
  // the repository cache's hold on a mounted tree
  repos: { hold(tree: string): (() => void) | null };
  // a sandbox another manager of this instance still holds, so no sweep
  // of this one deletes it
  foreign?(name: string): boolean;
};

export class Leases {
  private readonly book = new Book();
  private readonly changes: Changes;
  private closed = false;
  // a gateway-global policy is set: nothing runs
  private blocked = false;
  private readonly watch: Watch;
  private readonly cuts = new Cuts();
  private backoff: (() => void) | null = null;

  constructor(private readonly deps: LeasesDeps) {
    this.changes = new Changes(deps.clock);
    this.watch = new Watch({
      ...deps,
      live: () => this.book.live(),
      mark: () => this.book.tick(),
      gone: (lease) => this.remove(lease, "failed"),
      restarted: () => this.restarted(),
      reap: (found) => {
        const due = this.cuts.due(found, (name) => this.book.holds(name));
        for (const info of due) void this.adopt(info.name, info.phase);
      },
    });
  }

  async acquire(
    call: ShellCall,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxHold | "busy"> {
    try {
      return await this.lease(call, deadline, signal);
    } finally {
      // a pool held back while commands waited fills once none does
      this.refill();
    }
  }

  private async lease(
    call: ShellCall,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxHold | "busy"> {
    const key = call.workspace.id;
    const want = mountsKey(call.repos);
    for (;;) {
      signal.throwIfAborted();
      if (this.closed) throw new Error("the sandbox shell is stopping");
      if (this.blocked) throw new Error(GLOBAL_POLICY_REFUSAL);
      if (this.deps.clock() >= deadline) return "busy";
      const own = this.book.byWorkspace.get(key);
      if (own?.state === "idle" && own.mounts === want && !own.doomed) {
        return this.take(own);
      }
      if (own?.state === "idle") {
        this.remove(own, "mounts");
        continue;
      }
      if (own === undefined) {
        const warm = call.repos.length === 0 ? this.book.takeWarm() : null;
        if (warm !== null) {
          warm.workspace = key;
          this.book.byWorkspace.set(key, warm);
          this.refill();
          return this.take(warm);
        }
        if (this.book.counted() < this.deps.limits().sandboxesMax) {
          return this.make(key, call.repos, want, deadline, signal);
        }
        // one delete per waiting command: the first one's delete is
        // still pending when the next wake comes
        const victim =
          this.book.evicting() <= this.changes.waiting
            ? this.book.evictable()
            : null;
        if (victim !== null) {
          victim.evicted = true;
          this.remove(victim, "cap");
        }
      }
      // a delete observed, a release or a create ended may free one
      if (!(await this.changes.wait(deadline, signal))) return "busy";
    }
  }

  // the workspace's sandbox goes; a command holding it keeps it to its end
  recycle(workspace: string, reason: RecycleReason): void {
    const lease = this.book.byWorkspace.get(workspace);
    if (lease !== undefined) this.remove(lease, reason);
  }

  // every workspace of a session: a chat's, or each agent's in a channel
  recycleSession(sessionId: string, reason: RecycleReason): void {
    for (const [key, lease] of [...this.book.byWorkspace]) {
      if (key === sessionId || key.startsWith(`${sessionId}:`)) {
        this.remove(lease, reason);
      }
    }
  }

  // at start: what an earlier run left, then the pool and the probe
  async start(): Promise<void> {
    await this.sweep("start");
    this.refill();
    this.watch.arm();
  }

  // an exec answered that the sandbox is not ready or the gateway is
  // unavailable: the lease goes, and every other is checked soon. It
  // returns at once, since a check may wait on a sweep's deletes; a
  // command never waits on it
  sandboxFailed(workspace: string): void {
    this.recycle(workspace, "failed");
    void this.check();
  }

  // every lease dropped and its sandbox deleted, then what the gateway
  // still lists under our label, stuck ones asked to delete again
  async restarted(): Promise<void> {
    const leases = this.book.live();
    this.deps.log.warn("sandbox gateway restarted", { leases: leases.length });
    for (const lease of leases) this.remove(lease, "restart");
    await this.sweep("restart");
    this.refill();
  }

  // the leases against what the gateway lists (watch.ts)
  check(): Promise<void> {
    return this.watch.check();
  }

  rows(): LeaseRow[] {
    return this.book.rows();
  }

  counted(): number {
    return this.book.counted();
  }

  holds(name: string): boolean {
    return this.book.holds(name);
  }

  holding(): boolean {
    return this.book.holding();
  }

  blockedByPolicy(): boolean {
    return this.blocked;
  }

  // timers stopped; the sandboxes stay for the next start's sweep
  close(): void {
    this.closed = true;
    this.watch.close();
    this.backoff?.();
    for (const lease of this.book.records.values()) lease.timer?.();
    this.changes.changed();
  }

  // the settings moved off this gateway or image: every sandbox goes
  drain(): void {
    for (const lease of this.book.live()) this.remove(lease, "settings");
    this.close();
  }

  private take(lease: Lease): SandboxHold {
    lease.timer?.();
    lease.timer = null;
    lease.state = "leased";
    lease.usedAt = this.deps.clock();
    let done = false;
    return {
      sandbox: lease.name,
      keepAlivePid: lease.pid!,
      workspace: lease.workspace!,
      release: () => {
        if (done) return;
        done = true;
        this.release(lease);
      },
      recycle: (reason) => {
        if (done) return;
        done = true;
        this.destroy(lease, reason);
      },
    };
  }

  private release(lease: Lease): void {
    if (lease.state !== "leased") return;
    if (lease.doomed || this.closed) {
      this.destroy(lease, "discard");
      return;
    }
    lease.state = "idle";
    lease.usedAt = this.deps.clock();
    const ms = this.deps.limits().sandboxIdleMinutes * MINUTE_MS;
    lease.timer = after(this.deps.clock, ms, () => {
      lease.timer = null;
      if (lease.state === "idle") this.destroy(lease, "idle");
    });
    this.changes.changed();
  }

  private async make(
    key: string,
    repos: readonly ShellRepo[],
    mounts: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxHold | "busy"> {
    const lease = this.add(key, mounts);
    for (const repo of repos) {
      const release = this.deps.repos.hold(repo.tree);
      if (release === null) {
        this.destroy(lease, "failed");
        throw new Error(`the files of repository ${repo.name} are gone`);
      }
      lease.holds.push(release);
    }
    const step = bounded(
      this.deps.clock,
      deadline,
      signal,
      "the command's time ran out",
    );
    try {
      await this.build(lease, repos, step.signal);
    } catch (error) {
      this.destroy(lease, "failed");
      signal.throwIfAborted();
      if (step.signal.aborted) return "busy";
      this.deps.log.warn("sandbox create failed", {
        sandbox: lease.name,
        ...errorFields(error),
      });
      throw new Error("the sandbox could not be made");
    } finally {
      step.dispose();
    }
    return this.take(lease);
  }

  private add(workspace: string | null, mounts: string): Lease {
    return this.book.add(sandboxName(), workspace, mounts, this.deps.clock());
  }

  // create, ready, and the keep-alive's pid: every step on the signal
  private async build(
    lease: Lease,
    repos: readonly ShellRepo[],
    signal: AbortSignal,
  ): Promise<void> {
    const { gateway } = this.deps;
    const spec = createSpec({
      name: lease.name,
      instanceId: this.deps.instanceId,
      image: this.deps.image,
      caps: this.deps.limits(),
      repos,
    });
    await gateway.create(spec, signal);
    await gateway.waitReady(lease.name, signal);
    lease.phase = "ready";
    lease.pid = await readKeepAlive(gateway, lease.name, signal);
    lease.ready = this.book.tick();
    this.deps.log.info("sandbox created", {
      sandbox: lease.name,
      warm: lease.workspace === null,
      repos: repos.length,
    });
  }

  // a held lease, or one being made, is doomed and goes when that ends
  private remove(lease: Lease, reason: RecycleReason): void {
    if (lease.state === "leased" || lease.state === "creating") {
      lease.doomed = true;
      return;
    }
    this.destroy(lease, reason);
  }

  private destroy(lease: Lease, reason: RecycleReason): void {
    if (lease.state === "deleting" || lease.state === "stuck") return;
    // a create cut short may still land after this delete
    if (lease.state === "creating") this.cuts.mark(lease.name);
    lease.timer?.();
    lease.timer = null;
    this.book.unlink(lease);
    lease.state = "deleting";
    this.deps.log.info("sandbox recycled", { sandbox: lease.name, reason });
    void this.delete(lease);
  }

  // the sandbox, then the wait until the gateway forgets it; the cache
  // trees it mounted stay held until then, since a bind is not moved by
  // a tree published again at the same path
  private async delete(lease: Lease): Promise<void> {
    const ctl = new AbortController();
    const cancel = after(this.deps.clock, DELETE_TIMEOUT_MS, () =>
      ctl.abort(new Error("delete timed out")),
    );
    try {
      await this.deps.gateway.delete(lease.name, ctl.signal);
      await this.deps.gateway.waitDeleted(lease.name, ctl.signal);
      this.book.forget(lease);
    } catch (error) {
      // a delete past its timeout is stuck; another failure, a blip,
      // is asked again a few times first
      const timedOut = ctl.signal.aborted;
      if (!timedOut && lease.tries < DELETE_TRIES - 1 && !this.closed) {
        const wait = DELETE_RETRY_MS * 3 ** lease.tries;
        lease.tries++;
        lease.timer = after(this.deps.clock, wait, () => {
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
      await this.stuck(lease);
    } finally {
      cancel();
    }
    this.changes.changed();
    this.refill();
  }

  // a stuck sandbox's phase, never another delete: one the gateway can
  // no longer remove (a driver operation left pending) would only be
  // asked again forever
  private async stuck(lease: Lease): Promise<void> {
    if (this.closed || lease.state !== "stuck") return;
    const phase = await ask(this.deps.clock, this.deps.log, STEP_MS, (signal) =>
      this.deps.gateway.phase(lease.name, signal),
    );
    if (phase === "gone") {
      this.book.forget(lease);
      this.changes.changed();
      return;
    }
    if (phase !== null) lease.phase = phase;
    if (this.closed) return;
    lease.timer = after(this.deps.clock, STUCK_CHECK_MS, () => {
      lease.timer = null;
      void this.stuck(lease);
    });
  }

  // the pool topped up in the background, never past the cap and never
  // while a command waits for room
  private refill(): void {
    if (this.closed || this.blocked || this.backoff !== null) return;
    const caps = this.deps.limits();
    let warm = this.book.warm();
    while (
      warm < caps.sandboxWarm &&
      this.book.counted() < caps.sandboxesMax &&
      this.changes.waiting === 0
    ) {
      warm++;
      void this.warm();
    }
  }

  private async warm(): Promise<void> {
    const lease = this.add(null, mountsKey([]));
    const ctl = new AbortController();
    const cancel = after(this.deps.clock, WARM_CREATE_MS, () =>
      ctl.abort(new Error("warm create timed out")),
    );
    try {
      await this.build(lease, [], ctl.signal);
      if (lease.doomed || this.closed) this.destroy(lease, "settings");
      else lease.state = "warm";
    } catch (error) {
      this.destroy(lease, "failed");
      this.deps.log.warn("sandbox create failed", {
        sandbox: lease.name,
        ...errorFields(error),
      });
      if (!this.closed && this.backoff === null) {
        this.backoff = after(this.deps.clock, REFILL_BACKOFF_MS, () => {
          this.backoff = null;
          this.refill();
        });
      }
    } finally {
      cancel();
    }
    this.changes.changed();
  }

  private async sweep(when: "start" | "restart"): Promise<void> {
    const { globalPolicy, listed } = await sweepLabelled(
      {
        ...this.deps,
        held: (name) =>
          this.book.holds(name) || this.deps.foreign?.(name) === true,
        adopt: (name, phase) => this.adopt(name, phase),
      },
      when,
    );
    // a sweep that could not list runs again at the next good probe
    if (!listed) this.watch.markLost();
    if (globalPolicy === true && !this.blocked) {
      this.deps.log.warn("sandbox gateway has a global policy");
    }
    if (globalPolicy !== null) this.blocked = globalPolicy;
  }

  // a sandbox no lease uses, or a stuck one, deleted again
  private adopt(name: string, phase: SandboxPhase): Promise<void> {
    const lease =
      this.book.records.get(name) ??
      this.book.add(name, null, mountsKey([]), this.deps.clock());
    lease.timer?.();
    lease.timer = null;
    lease.phase = phase;
    lease.state = "deleting";
    lease.tries = 0;
    return this.delete(lease);
  }
}
