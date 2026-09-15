// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import type { DiscoveryResult } from "./discover.ts";
import { AUTOMATIC_HOLD_MS, REFRESH_INTERVAL_MS } from "./limits.ts";
import type { McpServerRow, McpServerStore } from "./store.ts";

export type RefreshKind = "automatic" | "refresh" | "candidate";

type Active = {
  controller: AbortController;
  promise: Promise<unknown>;
  kind: RefreshKind;
};

export type Take<T> =
  | { status: "taken"; promise: Promise<T>; signal: AbortSignal }
  | { status: "busy" }
  | { status: "closed" };

export class RefreshCoordinator {
  private readonly active = new Map<string, Active>();
  private readonly automaticStarts = new Map<string, number>();
  private closed = false;
  private loop: Promise<void> | null = null;
  private wakeClose: (() => void) | null = null;
  private readonly closedWait = new Promise<void>((resolve) => {
    this.wakeClose = resolve;
  });

  constructor(
    private readonly deps: {
      store: McpServerStore;
      clock: Clock;
      log: Log;
      discover(
        row: Pick<McpServerRow, "url" | "keyName">,
        signal: AbortSignal,
      ): Promise<DiscoveryResult>;
    },
  ) {}

  take<T>(
    id: string,
    kind: RefreshKind,
    work: (signal: AbortSignal) => Promise<T>,
  ): Take<T> {
    if (this.closed) return { status: "closed" };
    if (this.active.has(id)) return { status: "busy" };
    const controller = new AbortController();
    const active = {} as Active;
    const promise = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        if (this.active.get(id) === active) this.active.delete(id);
      });
    active.controller = controller;
    active.promise = promise;
    active.kind = kind;
    this.active.set(id, active);
    return { status: "taken", promise, signal: controller.signal };
  }

  abort(id: string): void {
    this.active.get(id)?.controller.abort(new Error("server deleted"));
  }

  private startAutomatic(
    row: McpServerRow,
    observed?: string,
  ): Promise<void> | null {
    if (this.closed) return null;
    if (observed !== undefined && row.fingerprint === observed) return null;
    const last = this.automaticStarts.get(row.id);
    if (last !== undefined && this.deps.clock() - last < AUTOMATIC_HOLD_MS) {
      return null;
    }
    const taken = this.take(row.id, "automatic", async (signal) => {
      try {
        const found = await this.deps.discover(row, signal);
        if (signal.aborted) return;
        this.deps.store.applyDiscovery(row.id, found);
      } catch (error) {
        if (signal.aborted) return;
        const words = error instanceof Error ? error.message : String(error);
        this.deps.store.recordFailure(row.id, words, this.deps.clock());
        this.deps.log(`server ${row.name} refresh failed: ${words}`);
      }
    });
    if (taken.status !== "taken") return null;
    this.automaticStarts.set(row.id, this.deps.clock());
    return taken.promise;
  }

  refreshSoon(id: string, observed: string): void {
    try {
      const row = this.deps.store.byId(id);
      if (row !== null) this.startAutomatic(row, observed);
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error);
      this.deps.log(`server refresh could not start: ${words}`);
    }
  }

  private async pass(): Promise<void> {
    const before = this.deps.clock() - REFRESH_INTERVAL_MS;
    for (const row of this.deps.store.stale(before)) {
      if (this.closed) return;
      const running = this.startAutomatic(row);
      if (running !== null) await running;
    }
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.clock.sleep) {
      return Promise.race([this.deps.clock.sleep(ms), this.closedWait]);
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void this.closedWait.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  start(): void {
    if (this.closed || this.loop !== null) return;
    this.loop = (async () => {
      while (!this.closed) {
        await this.wait(REFRESH_INTERVAL_MS);
        if (this.closed) return;
        await this.pass();
      }
    })();
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.wakeClose?.();
      for (const [id, active] of this.active) {
        if (active.kind === "automatic") this.automaticStarts.delete(id);
        active.controller.abort(new Error("server shutting down"));
      }
    }
    await Promise.allSettled([
      ...Array.from(this.active.values(), (entry) => entry.promise),
      ...(this.loop === null ? [] : [this.loop]),
    ]);
  }
}
