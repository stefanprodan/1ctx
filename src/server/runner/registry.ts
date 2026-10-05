// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Active sends by session and synchronous admission (docs/sessions.md).

import {
  Conflict,
  ServiceUnavailable,
  TooManyRequests,
} from "../lib/errors.ts";
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

// a full cap met by a send a user started; the queue's dispatcher reads
// which one from the class, never from the words
export class CapFull extends TooManyRequests {
  constructor(
    readonly cap: "user" | "project" | "process",
    message: string,
  ) {
    super(message);
  }
}

// the lock's own refusal: the chat's send holds it
export class LockHeld extends Conflict {}

// every admission from the first signal to the exit
export class Restarting extends ServiceUnavailable {
  constructor() {
    super("the server is restarting");
  }
}

// the count, not the cap: a lowered cap leaves more going
const going = (n: number): string =>
  n === 1 ? "1 chat or run" : `${n} chats and runs`;

const projectFull = (n: number): string =>
  `This project has ${going(n)} going. Try again in a moment.`;

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
    if (this.closed) throw new Restarting();
    const own = this.sends.get(sessionId);
    if (own === undefined) return;
    if (own.terminal !== null) {
      throw new LockHeld(
        "still stopping the last reply; try again in a moment",
      );
    }
    throw new LockHeld(`${own.policy.fullName} is sending`);
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
        throw new RunCapacity("project", projectFull(project));
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
      throw new CapFull(
        "user",
        `You have ${going(mine)} going. Wait for one to end.`,
      );
    }
    if (project >= caps.sendsPerProject) {
      throw new CapFull("project", projectFull(project));
    }
    if (running >= caps.sendsRunning) {
      throw new CapFull(
        "process",
        "Too many chats and runs are going. Try again in a moment.",
      );
    }
  }

  // the sends a user started that hold a place now
  startedBy(userId: string): number {
    let n = 0;
    for (const send of this.sends.values()) {
      if (send.startedBy === userId) n++;
    }
    return n;
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

  // no more admissions: the drain has begun
  close(): void {
    this.closed = true;
  }
}
