// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The active sends by session, and admission: synchronous, taken
// before startSend, with nothing written before it passes. A session
// takes one send at a time; a terminated send holds the lock until its
// stream has let go, so a second send cannot start on a reply that is
// still being written. Every send counts in one tally under three caps,
// limits the caller reads in the admission's turn: per user who started
// it, per project and in the process. A scheduled run has no one who
// started it and may hold only a share of the project's and the
// process's places, so the rest stays free for users.

import { Conflict, TooManyRequests } from "../lib/errors.ts";
import { type SendCaps, scheduledShare } from "../limits/index.ts";
import type { ActiveSend } from "./send.ts";

// who a send counts against: the user who started it, null for a
// scheduled run, and the session's project
export type Starter = { userId: string | null; projectId: string };

export type Running = {
  chats: number;
  runs: number;
  scheduled: number;
  // the projects whose every place is taken
  projectsFull: number;
};

// a full cap met by a scheduled run; the scheduler reads which one from
// the class, never from the words
export class RunCapacity extends TooManyRequests {
  constructor(
    readonly cap: "project" | "process",
    message: string,
  ) {
    super(message);
  }
}

export class Registry {
  private readonly sends = new Map<string, ActiveSend>();
  private closed = false;

  get(sessionId: string): ActiveSend | null {
    return this.sends.get(sessionId) ?? null;
  }

  values(): ActiveSend[] {
    return [...this.sends.values()];
  }

  get size(): number {
    return this.sends.size;
  }

  // the sends holding a place now; a terminated send holds its place
  // until its stream has let go
  running(perProject: number): Running {
    let chats = 0;
    let runs = 0;
    let scheduled = 0;
    const projects = new Map<string, number>();
    for (const send of this.sends.values()) {
      if (send.kind === "run") runs++;
      else chats++;
      if (send.startedBy === null) scheduled++;
      projects.set(send.projectId, (projects.get(send.projectId) ?? 0) + 1);
    }
    let projectsFull = 0;
    for (const count of projects.values()) {
      if (count >= perProject) projectsFull++;
    }
    return { chats, runs, scheduled, projectsFull };
  }

  // the lock's refusals alone, for a caller that checks before it builds
  // a send
  locked(sessionId: string): void {
    if (this.closed) throw new Conflict("the server is shutting down");
    const own = this.sends.get(sessionId);
    if (own === undefined) return;
    if (own.terminal !== null) {
      throw new Conflict(
        "still stopping the last reply; try again in a moment",
      );
    }
    throw new Conflict(`${own.policy.fullName} is sending`);
  }

  // throws the refusal, or returns; the caller reserves with set() in
  // the same turn, with no await between
  admit(sessionId: string, who: Starter, caps: SendCaps): void {
    this.locked(sessionId);
    let running = 0;
    let mine = 0;
    let project = 0;
    let scheduled = 0;
    let scheduledHere = 0;
    for (const send of this.sends.values()) {
      running++;
      const here = send.projectId === who.projectId;
      if (here) project++;
      if (send.startedBy === null) {
        scheduled++;
        if (here) scheduledHere++;
      } else if (send.startedBy === who.userId) {
        mine++;
      }
    }
    if (who.userId === null) {
      if (
        project >= caps.sendsPerProject ||
        scheduledHere >= scheduledShare(caps.sendsPerProject)
      ) {
        throw new RunCapacity(
          "project",
          `This project has ${caps.sendsPerProject} chats and runs going. Try again in a moment.`,
        );
      }
      if (
        running >= caps.sendsRunning ||
        scheduled >= scheduledShare(caps.sendsRunning)
      ) {
        throw new RunCapacity(
          "process",
          "Too many chats and runs are going. Try again in a moment.",
        );
      }
      return;
    }
    if (mine >= caps.sendsPerUser) {
      // the count, not the cap: a lowered cap leaves more going
      const going = mine === 1 ? "1 chat or run" : `${mine} chats and runs`;
      throw new TooManyRequests(
        `You have ${going} going. Wait for one to end.`,
      );
    }
    if (project >= caps.sendsPerProject) {
      throw new TooManyRequests(
        `This project has ${caps.sendsPerProject} chats and runs going. Try again in a moment.`,
      );
    }
    if (running >= caps.sendsRunning) {
      throw new TooManyRequests(
        "Too many chats and runs are going. Try again in a moment.",
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
