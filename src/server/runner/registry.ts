// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The active sends by session, and admission: synchronous, taken
// before startSend, with nothing written before it passes. A session
// takes one send at a time; a terminated send holds the lock until its
// stream has let go, so a second send cannot start on a reply that is
// still being written. Two caps bound the process while limits are not
// rows: sends running at once, and per user.

import { Conflict, TooManyRequests } from "../lib/errors.ts";
import type { ActiveSend } from "./send.ts";

export const MAX_RUNNING = 32;
export const MAX_RUNNING_PER_USER = 4;

export class Registry {
  private readonly sends = new Map<string, ActiveSend>();
  private closed = false;

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

  // throws the refusal, or returns; the caller reserves with set() in
  // the same turn, with no await between
  admit(sessionId: string, userId: string): void {
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
    if (this.sends.size >= this.caps.running) {
      throw new TooManyRequests(
        "too many chats running; try again in a moment",
      );
    }
    let mine = 0;
    for (const send of this.sends.values()) {
      if (send.policy.userId === userId) mine++;
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
