// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The active sends by session, and admission: synchronous, taken
// before startSend, with nothing written before it passes. A session
// takes one send at a time; a terminated send holds the lock until its
// stream has let go, so a second send cannot start on a reply that is
// still being written. Chats and runs are two pools, each capped in the
// process and per user: the chat caps are constants, the run caps are
// limits the runner reads and passes at each admission.

import { Conflict, TooManyRequests } from "../lib/errors.ts";
import type { ActiveSend } from "./send.ts";

export const MAX_RUNNING = 32;
export const MAX_RUNNING_PER_USER = 4;

export type Pool =
  | { kind: "chat" }
  | { kind: "run"; perUser: number; running: number };

export const CHAT_POOL: Pool = { kind: "chat" };

// the run caps as limits.current() answers them in the admission's turn
export function runPool(limits: {
  runsPerUser: number;
  runsRunning: number;
}): Pool {
  return {
    kind: "run",
    perUser: limits.runsPerUser,
    running: limits.runsRunning,
  };
}

// a full run pool; the scheduler reads which one from the class, never
// from the words
export class RunCapacity extends TooManyRequests {
  constructor(
    readonly pool: "user" | "process",
    message: string,
  ) {
    super(message);
  }
}

const poolOf = (send: ActiveSend) => (send.kind === "run" ? "run" : "chat");

export class Registry {
  private readonly sends = new Map<string, ActiveSend>();
  private closed = false;

  // the chat pool's caps; a test passes its own
  constructor(
    private readonly caps: { running: number; perUser: number } = {
      running: MAX_RUNNING,
      perUser: MAX_RUNNING_PER_USER,
    },
  ) {}

  get(sessionId: string): ActiveSend | null {
    return this.sends.get(sessionId) ?? null;
  }

  values(): ActiveSend[] {
    return [...this.sends.values()];
  }

  get size(): number {
    return this.sends.size;
  }

  // the chat pool's process cap, for the overview
  get chatsCap(): number {
    return this.caps.running;
  }

  // the sends holding a slot now, by pool; a terminated send holds its
  // slot until its stream has let go
  running(): { chats: number; runs: number } {
    let chats = 0;
    let runs = 0;
    for (const send of this.sends.values()) {
      if (poolOf(send) === "run") runs++;
      else chats++;
    }
    return { chats, runs };
  }

  // throws the refusal, or returns; the caller reserves with set() in
  // the same turn, with no await between
  admit(sessionId: string, userId: string, pool: Pool): void {
    if (this.closed) throw new Conflict("the server is shutting down");
    const own = this.sends.get(sessionId);
    if (own) {
      if (own.terminal !== null) {
        throw new Conflict(
          "still stopping the last reply; try again in a moment",
        );
      }
      throw new Conflict(`${own.policy.fullName} is sending`);
    }
    let running = 0;
    let mine = 0;
    for (const send of this.sends.values()) {
      if (poolOf(send) !== pool.kind) continue;
      running++;
      if (send.policy.userId === userId) mine++;
    }
    if (pool.kind === "run") {
      if (running >= pool.running) {
        throw new RunCapacity(
          "process",
          "too many tasks running; try again in a moment",
        );
      }
      if (mine >= pool.perUser) {
        throw new RunCapacity(
          "user",
          `${pool.perUser} of your tasks are running; wait for one`,
        );
      }
      return;
    }
    if (running >= this.caps.running) {
      throw new TooManyRequests(
        "too many chats running; try again in a moment",
      );
    }
    if (mine >= this.caps.perUser) {
      throw new TooManyRequests(
        `${this.caps.perUser} of your chats are running; wait for one`,
      );
    }
  }

  set(send: ActiveSend): void {
    this.sends.set(send.sessionId, send);
  }

  // an old send never frees its replacement's lock
  free(send: ActiveSend): boolean {
    if (this.sends.get(send.sessionId) !== send) return false;
    this.sends.delete(send.sessionId);
    return true;
  }

  // no more admissions: shutdown has begun
  close(): void {
    this.closed = true;
  }
}
