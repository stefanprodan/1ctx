// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandboxes of one gateway, by workspace. A sandbox is a cache of
// the rows: any of them may be deleted between two commands and made
// again, so every doubt (a mismatch, a clear, a lost gateway) deletes
// rather than repairs. Deletes run in the background (deletes.ts) and
// never block a command.

import type { LeaseRow } from "../../shared/contracts/sandbox.ts";
import type { ShellCall, ShellRepo, StoredBytes } from "../bash/index.ts";
import { after, type Clock, MINUTE_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { KnowledgeCaps, SandboxCaps } from "../limits/index.ts";
import { Book, type Lease } from "./book.ts";
import { buildSandbox } from "./create.ts";
import { Deletes } from "./deletes.ts";
import type { Gateway } from "./gateway.ts";
import type { RecycleReason, SandboxHold } from "./hold.ts";
import { GLOBAL_POLICY_REFUSAL, Network } from "./network.ts";
import { PolicyGate } from "./policy.ts";
import { ImageCheck, ImageRefused } from "./roots.ts";
import { fitsCaps, mountsKey, sandboxName } from "./spec.ts";
import { Cuts, sweepLabelled } from "./sweep.ts";
import { bounded, Changes } from "./waits.ts";
import { Watch } from "./watch.ts";

export {
  DELETE_RETRY_MS,
  DELETE_TIMEOUT_MS,
  STUCK_CHECK_MS,
} from "./deletes.ts";
export type { RecycleReason, SandboxHold } from "./hold.ts";

// a warm sandbox's create, which no command's deadline bounds
export const WARM_CREATE_MS = 120_000;
// a failed warm create waits this long before the pool tries again
export const REFILL_BACKOFF_MS = 30_000;

export type LeasesDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  instanceId: string;
  image: string;
  limits(): KnowledgeCaps & SandboxCaps;
  // the repository cache's hold on a mounted tree
  repos: { hold(tree: string): (() => void) | null };
  // the managers the settings moved off, still deleting: their sandboxes
  // count against the cap, and no sweep of this one takes what they hold
  others?(): readonly Leases[];
  // a delete of this manager was observed, so another may admit one
  freed?(): void;
  // the provider locks every manager of the instance shares
  locks?: Map<string, Promise<unknown>>;
};

export class Leases {
  private readonly book = new Book((lease) => this.net.forgot(lease.name));
  private readonly net: Network;
  private readonly changes: Changes;
  private closed = false;
  // the settings moved off: no lease, every delete run to its end
  private draining = false;
  private drained: (() => void) | null = null;
  private readonly policy: PolicyGate;
  private readonly image: ImageCheck;
  private readonly watch: Watch;
  private readonly cuts = new Cuts();
  private readonly deletes: Deletes;
  private backoff: (() => void) | null = null;

  constructor(private readonly deps: LeasesDeps) {
    this.changes = new Changes(deps.clock);
    this.net = new Network({
      ...deps,
      profileElsewhere: (id) => this.others().some((o) => o.holdsProfile(id)),
      globalPolicy: (set) => this.policy.seen(set),
    });
    this.image = new ImageCheck(deps.image, deps.log);
    this.deletes = new Deletes({
      ...deps,
      book: this.book,
      cuts: this.cuts,
      closed: () => this.closed,
      draining: () => this.draining,
      forgot: () => {
        this.deps.freed?.();
        this.settleDrain();
      },
      ended: () => this.poke(),
    });
    this.policy = new PolicyGate({ ...deps, cleared: () => this.poke() });
    this.watch = new Watch({
      ...deps,
      live: () => this.book.live(),
      mark: () => this.book.tick(),
      gone: (lease) => this.remove(lease, "failed"),
      restarted: () => this.restarted(),
      reap: (found) => {
        const due = this.cuts.due(found, (name) => this.book.holds(name));
        for (const info of due) void this.deletes.adopt(info.name, info.phase);
      },
    });
  }

  async acquire(
    call: ShellCall,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxHold | "busy"> {
    try {
      for (;;) {
        const hold = await this.lease(call, deadline, signal);
        if (hold === "busy") return hold;
        const net = await this.net.configure(hold, call, deadline, signal);
        if (net !== "recycled") return net === "busy" ? net : hold;
      }
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
    // read once, and only when a sandbox is taken or made for the call
    let stored: StoredBytes | undefined;
    for (;;) {
      signal.throwIfAborted();
      if (this.closed) throw new Error("the sandbox shell is stopping");
      if (this.draining) {
        throw new Error("the sandbox settings changed: run the command again");
      }
      if (this.image.refused !== null) throw this.image.refused;
      if (!(await this.policy.open(deadline, signal))) {
        throw new Error(GLOBAL_POLICY_REFUSAL);
      }
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
        stored ??= call.stored?.();
        const held = stored;
        // a warm sandbox is sized from the caps: a tree over a lowered
        // cap needs one of its own
        const fits = held === undefined || fitsCaps(this.deps.limits(), held);
        const warm =
          call.repos.length === 0 && fits ? this.book.takeWarm() : null;
        if (warm !== null) {
          warm.workspace = key;
          this.book.byWorkspace.set(key, warm);
          this.refill();
          return this.take(warm);
        }
        if (this.total() < this.deps.limits().sandboxesMax) {
          const made = await this.make(key, call, want, held, deadline, signal);
          // doomed while it was made: deleted, and the loop goes again
          if (made !== null) return made;
          continue;
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

  // this manager's own sandboxes against the cap
  counted(): number {
    return this.book.counted();
  }

  holds(name: string): boolean {
    return this.book.holds(name);
  }

  holdsProvider(name: string): boolean {
    return this.net.holds(name);
  }

  holdsProfile(id: string): boolean {
    return this.net.holdsProfile(id);
  }

  // why every command is refused, for the admin; null while none is
  refused(): string | null {
    if (this.image.refused !== null) return this.image.refused.message;
    return this.policy.blocked ? GLOBAL_POLICY_REFUSAL : null;
  }

  // another manager's delete observed: a waiting command may fit now
  poke(): void {
    this.changes.changed();
    this.refill();
  }

  // timers stopped; the sandboxes stay for the next start's sweep
  close(): void {
    this.closed = true;
    this.watch.close();
    this.backoff?.();
    for (const lease of this.book.records.values()) lease.timer?.();
    this.changes.changed();
  }

  // the settings moved off this gateway or image: every sandbox goes,
  // held ones at their release, and each delete runs to its end, so the
  // repository holds go with it. Settles once no record is left and
  // their providers' deletes ended, when the caller closes the client
  drain(): Promise<void> {
    this.draining = true;
    this.watch.close();
    this.backoff?.();
    this.backoff = null;
    const done = new Promise<void>((resolve) => {
      this.drained = resolve;
    });
    for (const lease of this.book.live()) this.remove(lease, "settings");
    this.changes.changed();
    this.settleDrain();
    return done.then(() => this.net.dropped());
  }

  private settleDrain(): void {
    if (this.drained === null || this.book.records.size > 0) return;
    this.drained();
    this.drained = null;
  }

  // every manager's sandboxes, since the cap is the instance's
  private total(): number {
    const own = this.book.counted();
    return this.others().reduce((n, other) => n + other.counted(), own);
  }

  private others(): Leases[] {
    return (this.deps.others?.() ?? []).filter((other) => other !== this);
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
      keepAliveStart: lease.started!,
      workspace: lease.workspace!,
      gateway: this.deps.gateway,
      synced: lease.synced,
      network: lease.network,
      notice: "",
      failed: () => void this.sandboxFailed(lease.workspace!),
      release: () => {
        if (done) return;
        done = true;
        this.release(lease);
      },
      recycle: (reason) => {
        if (done) return;
        done = true;
        this.deletes.destroy(lease, reason);
      },
    };
  }

  private release(lease: Lease): void {
    if (lease.state !== "leased") return;
    if (lease.doomed || this.closed || this.draining) {
      this.deletes.destroy(lease, "discard");
      return;
    }
    lease.state = "idle";
    lease.usedAt = this.deps.clock();
    const ms = this.deps.limits().sandboxIdleMinutes * MINUTE_MS;
    lease.timer = after(this.deps.clock, ms, () => {
      lease.timer = null;
      if (lease.state === "idle") this.deletes.destroy(lease, "idle");
    });
    this.changes.changed();
  }

  // null when a recycle or the settings doomed it while it was made
  private async make(
    key: string,
    call: ShellCall,
    mounts: string,
    stored: StoredBytes | undefined,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxHold | "busy" | null> {
    const { repos } = call;
    const lease = this.add(key, mounts);
    for (const repo of repos) {
      const release = this.deps.repos.hold(repo.tree);
      if (release === null) {
        this.deletes.destroy(lease, "failed");
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
      await this.build(lease, repos, stored, step.signal);
    } catch (error) {
      this.deletes.destroy(lease, "failed");
      signal.throwIfAborted();
      if (step.signal.aborted) return "busy";
      if (error instanceof ImageRefused) throw error;
      this.deps.log.warn("sandbox create failed", {
        sandbox: lease.name,
        ...errorFields(error),
      });
      throw new Error("the sandbox could not be made");
    } finally {
      step.dispose();
    }
    if (lease.doomed || this.closed || this.draining) {
      this.deletes.destroy(lease, "discard");
      return null;
    }
    return this.take(lease);
  }

  private add(workspace: string | null, mounts: string): Lease {
    return this.book.add(sandboxName(), workspace, mounts, this.deps.clock());
  }

  // made (create.ts), then in the book's order for the probe
  private async build(
    lease: Lease,
    repos: readonly ShellRepo[],
    stored: StoredBytes | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await buildSandbox(this.deps, this.image, lease, repos, stored, signal);
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
    this.deletes.destroy(lease, reason);
  }

  // the pool topped up in the background, never past the cap and never
  // while a command waits for room
  private refill(): void {
    if (this.closed || this.draining || this.backoff !== null) return;
    if (this.policy.blocked || this.image.refused !== null) return;
    const caps = this.deps.limits();
    let warm = this.book.warm();
    while (
      warm < caps.sandboxWarm &&
      this.total() < caps.sandboxesMax &&
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
      await this.build(lease, [], undefined, ctl.signal);
      if (lease.doomed || this.closed || this.draining) {
        this.deletes.destroy(lease, "settings");
      } else lease.state = "warm";
    } catch (error) {
      this.deletes.destroy(lease, "failed");
      this.deps.log.warn("sandbox create failed", {
        sandbox: lease.name,
        ...errorFields(error),
      });
      if (!this.closed && !this.draining && this.backoff === null) {
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
          this.book.holds(name) ||
          this.others().some((other) => other.holds(name)),
        dropProvider: (name) =>
          this.net.sweep(name, (provider) =>
            this.others().some((other) => other.holdsProvider(provider)),
          ),
        dropProfile: (id) => this.net.sweepProfile(id),
        adopt: (name, phase) => this.deletes.adopt(name, phase),
      },
      when,
    );
    // a sweep that could not list runs again at the next good probe
    if (!listed) this.watch.markLost();
    this.policy.seen(globalPolicy);
  }
}
