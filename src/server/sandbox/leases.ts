// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandboxes of one gateway, by root workspace: a chat's commands
// and its subagents' share one. A sandbox is a cache of
// the rows: any of them may be deleted between two commands and made
// again, so every doubt (a mismatch, a clear, a lost gateway) deletes
// rather than repairs. Deletes run in the background (deletes.ts) and
// never block a command.

import type { LeaseRow } from "../../shared/contracts/sandbox.ts";
import type { ShellCall, ShellRepo, StoredBytes } from "../bash/index.ts";
import { after, type Clock, MINUTE_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { KnowledgeCaps, SandboxCaps } from "../limits/index.ts";
import { RepoUnshared } from "./binds.ts";
import { Book, type Lease } from "./book.ts";
import { buildSandbox } from "./create.ts";
import { Deletes } from "./deletes.ts";
import type { Gateway } from "./gateway.ts";
import type { RecycleReason, SandboxHold } from "./hold.ts";
import { configureInTurn, holdOf, SANDBOX_COMMANDS } from "./holders.ts";
import { GLOBAL_POLICY_REFUSAL, Network, type NetworkDeps } from "./network.ts";
import { PolicyGate } from "./policy.ts";
import { WarmPool } from "./pool.ts";
import { ImageChecks, ImageRefused } from "./roots.ts";
import { fitsCaps, mountsKey, sandboxName } from "./spec.ts";
import { Cuts } from "./sweep.ts";
import { Sweeper } from "./sweeper.ts";
import { bounded, Changes, Gate, wakeAll } from "./waits.ts";
import { Watch } from "./watch.ts";

export type LeasesDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  instanceId: string;
  // the instance's image, the one the warm pool makes
  image: string;
  // a project's image, its own variant's over the instance's
  imageOf?(projectId: string): string;
  limits(): KnowledgeCaps & SandboxCaps;
  // the repository cache's hold on a mounted tree
  repos: { hold(tree: string): (() => void) | null };
  // the managers the settings moved off, still deleting: their sandboxes
  // count against the cap
  others?(): readonly Leases[];
  // a salt in this manager's provider and profile names, so a delete of
  // its own never takes another manager's, on whatever gateway
  owner?: string;
  // a delete of this manager was observed, so another may admit one
  freed?(): void;
  // the provider locks every manager of the instance shares
  locks?: Map<string, Promise<unknown>>;
  net?: NetworkDeps["net"];
  // a sweep listed every kind: what an earlier run left is known
  listed?(): void;
};

export class Leases {
  private readonly book = new Book((lease) => this.net.forgot(lease.name));
  private readonly net: Network;
  private readonly changes: Changes;
  // a command waiting for a sandbox past SANDBOX_COMMANDS: any release
  private readonly seats: Changes;
  private closed = false;
  // the settings moved off: no lease, every delete run to its end
  private draining = false;
  private drained: (() => void) | null = null;
  private readonly policy: PolicyGate;
  private readonly images: ImageChecks;
  private readonly watch: Watch;
  private readonly cuts = new Cuts();
  private readonly deletes: Deletes;
  private readonly pool: WarmPool;
  // shut from start until a sweep recorded what an earlier run left, so
  // no create passes the cap before those count
  private readonly starting = new Gate();
  private readonly sweeper: Sweeper;

  constructor(private readonly deps: LeasesDeps) {
    this.changes = new Changes(deps.clock);
    this.seats = new Changes(deps.clock);
    this.net = new Network({
      ...deps,
      profileElsewhere: (id) => this.others().some((o) => o.holdsProfile(id)),
      providerElsewhere: (name) =>
        this.others().some((o) => o.holdsProvider(name)),
      globalPolicy: (set) => this.policy.seen(set),
      closed: () => this.closed,
    });
    this.images = new ImageChecks(deps.log);
    this.deletes = new Deletes({
      ...deps,
      book: this.book,
      cuts: this.cuts,
      closed: () => this.closed,
      retired: () => this.draining,
      forgot: () => {
        this.deps.freed?.();
        this.settleDrain();
      },
      ended: () => this.poke(),
    });
    this.policy = new PolicyGate({ ...deps, cleared: () => this.poke() });
    this.pool = new WarmPool({
      ...deps,
      book: this.book,
      deletes: this.deletes,
      stopped: () => this.closed || this.draining,
      blocked: () =>
        this.policy.blocked ||
        this.images.refused(deps.image) !== null ||
        this.starting.shut,
      total: () => this.total(),
      waiting: () => this.changes.waiting,
      build: (signal) => {
        const lease = this.add(null, mountsKey([]), deps.image);
        return { lease, built: this.build(lease, [], undefined, signal) };
      },
      changed: () => this.changes.changed(),
    });
    this.watch = new Watch({
      ...deps,
      live: () => this.book.live(),
      mark: () => this.book.tick(),
      gone: (lease) => this.remove(lease, "failed"),
      restarted: () => this.restarted(),
      sweep: () => this.sweeper.sweep("again").then(() => this.pool.refill()),
      reap: (found) => {
        const due = this.cuts.due(found, (name) => this.book.holds(name));
        for (const info of due) void this.deletes.adopt(info.name, info.phase);
      },
    });
    this.sweeper = new Sweeper({
      ...deps,
      book: this.book,
      net: this.net,
      deletes: this.deletes,
      policy: this.policy,
      pool: this.pool,
      watch: this.watch,
      starting: this.starting,
      others: () => this.others(),
      remove: (lease, reason) => this.remove(lease, reason),
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
        const net = await configureInTurn(
          this.net,
          this.deps.clock,
          hold,
          call,
          deadline,
          signal,
        );
        if (net !== "recycled") return net === "busy" ? net : hold;
      }
    } finally {
      // a pool held back while commands waited fills once none does
      this.pool.refill();
    }
  }

  private async lease(
    call: ShellCall,
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxHold | "busy"> {
    const key = call.root;
    const want = mountsKey(call.repos);
    // read once, and only when a sandbox is taken or made for the call
    let stored: StoredBytes | undefined;
    if (!(await this.starting.pass(this.deps.clock, deadline, signal)))
      return "busy";
    for (;;) {
      let capped = false;
      signal.throwIfAborted();
      if (this.closed) throw new Error("the sandbox shell is stopping");
      if (this.draining) {
        throw new Error("the sandbox settings changed: run the command again");
      }
      // read again each pass, so a variant changed meanwhile is seen
      const image = this.deps.imageOf?.(call.projectId) ?? this.deps.image;
      this.images.pass(image);
      if (!(await this.policy.open(deadline, signal))) {
        throw new Error(GLOBAL_POLICY_REFUSAL);
      }
      if (this.deps.clock() >= deadline) return "busy";
      const own = this.book.byWorkspace.get(key);
      // a chat's subagents join its commands in their sandbox
      const open = own?.state === "idle" || own?.state === "leased";
      const same = own?.mounts === want && own.image === image;
      if (open && same && !own!.doomed) {
        if (own!.holders < SANDBOX_COMMANDS) return this.take(own!);
        if (!(await this.seats.wait(deadline, signal))) return "busy";
        continue;
      }
      // other repositories or, its project's variant changed, another
      // image: it goes once its commands let it go
      if (own?.state === "idle") {
        this.remove(own, own.image === image ? "mounts" : "image");
        continue;
      }
      if (own === undefined) {
        stored ??= call.stored?.();
        const held = stored;
        // a warm sandbox is sized from the caps: a tree over a lowered
        // cap needs one of its own
        const fits = held === undefined || fitsCaps(this.deps.limits(), held);
        // the pool holds the instance's image alone
        const warm =
          call.repos.length === 0 && fits && image === this.deps.image
            ? this.book.takeWarm()
            : null;
        if (warm !== null) {
          warm.workspace = key;
          this.book.byWorkspace.set(key, warm);
          this.pool.refill();
          return this.take(warm);
        }
        if (this.total() < this.deps.limits().sandboxesMax) {
          const spec = { mounts: want, image, stored: held };
          const hold = await this.make(key, call, spec, deadline, signal);
          // doomed while it was made: deleted, and the loop goes again
          if (hold !== null) return hold;
          continue;
        }
        // one delete per command at the cap: the first one's delete is
        // still pending when the next wake comes
        capped = true;
        const victim =
          this.book.evicting() <= this.changes.capped
            ? this.book.evictable()
            : null;
        if (victim !== null) {
          victim.evicted = true;
          this.remove(victim, "cap");
        }
      }
      // a delete observed, a release or a create ended may free one
      if (!(await this.changes.wait(deadline, signal, capped))) return "busy";
    }
  }

  // the root workspace's sandbox goes; the commands holding it keep it
  // to their end
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
  // (sweeper.ts)
  start(): Promise<void> {
    return this.sweeper.start();
  }

  // an exec answered that the sandbox is not ready or the gateway is
  // unavailable: the lease goes, and every other is checked soon. It
  // returns at once, since a check may wait on a sweep's deletes; a
  // command never waits on it
  sandboxFailed(workspace: string): void {
    this.recycle(workspace, "failed");
    void this.check();
  }

  // every lease dropped, then a sweep (sweeper.ts)
  restarted(): Promise<void> {
    return this.sweeper.restarted();
  }

  // the leases against what the gateway lists (watch.ts)
  check(): Promise<void> {
    return this.watch.check();
  }

  rows(): LeaseRow[] {
    return this.book.rows();
  }

  // this manager's own sandboxes against the cap
  counted(skip?: (name: string) => boolean): number {
    return this.book.counted(skip);
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
    const refused = this.images.refused(this.deps.image)?.message;
    return refused ?? (this.policy.blocked ? GLOBAL_POLICY_REFUSAL : null);
  }

  // another manager's delete observed: a waiting command may fit now
  poke(): void {
    this.changes.changed();
    this.pool.refill();
  }

  // timers stopped; the sandboxes stay for the next start's sweep
  close(): void {
    this.closed = true;
    this.watch.close();
    this.pool.stop();
    for (const lease of this.book.records.values()) lease.timer?.();
    wakeAll(this.starting, this.seats, this.changes);
  }

  // the settings moved off this gateway or image: every sandbox goes,
  // held ones at their release, and each delete runs to its end, so the
  // repository holds go with it. Settles once no record is left and
  // their providers' deletes ended, when the caller closes the client
  drain(): Promise<void> {
    this.draining = true;
    this.watch.close();
    this.pool.stop();
    const done = new Promise<void>((resolve) => {
      this.drained = resolve;
    });
    for (const lease of this.book.live()) this.remove(lease, "settings");
    wakeAll(this.starting, this.seats, this.changes);
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
    // a name this manager adopted from a retired one counts once
    const mine = (name: string) => this.book.records.has(name);
    return this.others().reduce((n, other) => n + other.counted(mine), own);
  }

  private others(): Leases[] {
    return (this.deps.others?.() ?? []).filter((other) => other !== this);
  }

  private take(lease: Lease): SandboxHold {
    lease.timer?.();
    lease.timer = null;
    lease.state = "leased";
    lease.holders++;
    lease.usedAt = this.deps.clock();
    // a command waiting for this lease's create may join it now
    this.changes.changed();
    return holdOf(lease, this.deps.gateway, {
      failed: () => void this.sandboxFailed(lease.workspace!),
      release: () => this.release(lease),
    });
  }

  // the last holder out: idle, or deleted when anything doomed it
  private release(lease: Lease): void {
    if (lease.state !== "leased") return;
    lease.holders--;
    this.seats.changed();
    lease.usedAt = this.deps.clock();
    if (lease.holders > 0) return;
    if (
      lease.recycled !== null ||
      lease.doomed ||
      this.closed ||
      this.draining
    ) {
      this.deletes.destroy(lease, lease.recycled ?? "discard");
      // a command waiting for its workspace's doomed sandbox makes
      // another now, never after the delete; the cap counts this one
      this.changes.changed();
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
    spec: { mounts: string; image: string; stored: StoredBytes | undefined },
    deadline: number,
    signal: AbortSignal,
  ): Promise<SandboxHold | "busy" | null> {
    const { repos } = call;
    const lease = this.add(key, spec.mounts, spec.image);
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
      await this.build(lease, repos, spec.stored, step.signal);
    } catch (error) {
      this.deletes.failed(lease, error);
      signal.throwIfAborted();
      if (step.signal.aborted) return "busy";
      // a host that cannot share a repository, seen outside the chat too
      if (error instanceof RepoUnshared)
        this.deps.log.warn("sandbox repository unreadable", {
          sandbox: lease.name,
          repos: error.unreadable,
        });
      if (error instanceof ImageRefused || error instanceof RepoUnshared)
        throw error;
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

  private add(workspace: string | null, mounts: string, image: string) {
    const now = this.deps.clock();
    return this.book.add(sandboxName(), workspace, mounts, image, now);
  }

  // made (create.ts), then in the book's order for the probe
  private async build(
    lease: Lease,
    repos: readonly ShellRepo[],
    stored: StoredBytes | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const check = this.images.of(lease.image);
    await buildSandbox(this.deps, check, lease, repos, stored, signal);
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
}
