// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The record of every sandbox one gateway runs for this instance, by
// name and by workspace: what counts against the cap and what may go
// first at it.

import type { LeaseRow, LeaseState } from "../../shared/contracts/sandbox.ts";
import type { SandboxPhase } from "./gateway.ts";

export type Lease = {
  name: string;
  // null while warm, and for a sandbox a sweep found
  workspace: string | null;
  // the repositories mounted at create, as mountsKey() writes them
  mounts: string;
  // the repository cache's holds on the trees mounted
  holds: (() => void)[];
  state: LeaseState;
  // a command holds it, or its create runs: deleted when that ends
  doomed: boolean;
  // deleted to make room at the cap, until its delete is observed
  evicted: boolean;
  // deletes that failed before its timeout
  tries: number;
  // when it was ready, in the book's own order; 0 before
  ready: number;
  pid: number | null;
  phase: SandboxPhase | null;
  createdAt: number;
  usedAt: number;
  // the idle delete, or a stuck sandbox's next phase check
  timer: (() => void) | null;
};

export class Book {
  readonly records = new Map<string, Lease>();
  readonly byWorkspace = new Map<string, Lease>();
  // an order of events, so a probe knows what was ready before it listed
  private serial = 0;

  tick(): number {
    return ++this.serial;
  }

  add(
    name: string,
    workspace: string | null,
    mounts: string,
    now: number,
  ): Lease {
    const lease: Lease = {
      name,
      workspace,
      mounts,
      holds: [],
      state: "creating",
      doomed: false,
      evicted: false,
      tries: 0,
      ready: 0,
      pid: null,
      phase: null,
      createdAt: now,
      usedAt: now,
      timer: null,
    };
    this.records.set(name, lease);
    if (workspace !== null) this.byWorkspace.set(workspace, lease);
    return lease;
  }

  // the workspace no longer reaches it; the record stays until its
  // delete is observed
  unlink(lease: Lease): void {
    if (
      lease.workspace !== null &&
      this.byWorkspace.get(lease.workspace) === lease
    ) {
      this.byWorkspace.delete(lease.workspace);
    }
  }

  // its delete observed: the record goes and the trees are let go
  forget(lease: Lease): void {
    this.unlink(lease);
    this.records.delete(lease.name);
    for (const release of lease.holds) release();
    lease.holds = [];
  }

  // what counts against sandboxesMax: everything the gateway may still
  // run, a stuck one too unless its container has exited
  counted(): number {
    let n = 0;
    for (const lease of this.records.values()) {
      if (lease.state !== "stuck" || lease.phase !== "error") n++;
    }
    return n;
  }

  // a sandbox still in use or being deleted; a stuck one is any sweep's
  // to ask again
  holds(name: string): boolean {
    const lease = this.records.get(name);
    return lease !== undefined && lease.state !== "stuck";
  }

  holding(): boolean {
    return [...this.records.keys()].some((name) => this.holds(name));
  }

  // deletes the cap asked for and the gateway has not finished
  evicting(): number {
    let n = 0;
    for (const lease of this.records.values()) {
      if (lease.evicted && lease.state === "deleting") n++;
    }
    return n;
  }

  // warm sandboxes, made or being made
  warm(): number {
    let n = 0;
    for (const lease of this.records.values()) {
      if (lease.workspace !== null) continue;
      if (lease.state === "warm" || lease.state === "creating") n++;
    }
    return n;
  }

  takeWarm(): Lease | null {
    for (const lease of this.records.values()) {
      if (lease.state === "warm") return lease;
    }
    return null;
  }

  // a sandbox to delete first at the cap: a warm one, then the least
  // recently used idle one; never one a command holds
  evictable(): Lease | null {
    let best: Lease | null = null;
    for (const lease of this.records.values()) {
      if (lease.state === "warm") return lease;
      if (lease.state !== "idle") continue;
      if (best === null || lease.usedAt < best.usedAt) best = lease;
    }
    return best;
  }

  live(): Lease[] {
    return [...this.records.values()].filter(
      (lease) => lease.state !== "deleting" && lease.state !== "stuck",
    );
  }

  rows(): LeaseRow[] {
    return [...this.records.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((lease) => ({
        workspace: lease.workspace,
        sandbox: lease.name,
        state: lease.state,
        phase: lease.phase,
        createdAt: lease.createdAt,
        usedAt: lease.usedAt,
      }));
  }
}
