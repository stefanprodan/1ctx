// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One admin socket sees every session envelope of every team project:
// the ends of the turns and the runs, and every send's summary, come
// from it. A lost envelope never hangs a turn: a wait past 10 minutes,
// and every wait after a reconnect, reads the session once.

import type { SessionResponse } from "../../../src/shared/api/sessions.ts";
import type { SendSummary } from "../../../src/shared/contracts/session.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import type { Api, Who } from "./api.ts";
import { failure, MIN, now, sleep } from "./log.ts";

export type Seen = {
  id: string;
  projectId: string;
  origin: string;
  automationId: string | null;
  runSource: string | null;
  status: string;
  createdAt: number;
  sendId: string | null;
};

type Envelope = Extract<SocketEvent, { type: "session" }>;
type Waiter = {
  sendId: string | null;
  prev: string | null;
  resolve: (status: string) => void;
  since: number;
};

export class Monitor {
  readonly seen = new Map<string, Seen>();
  readonly sends = new Map<string, SendSummary>();
  private readonly waiters = new Map<string, Waiter[]>();
  private ending = false;
  closes = 0;

  constructor(
    private readonly api: Api,
    private readonly admin: Who,
  ) {}

  envelope(ev: Envelope) {
    const s = ev.session;
    const held = this.seen.get(s.id);
    // an envelope older than the one held says nothing new
    if (held && ev.send === null && held.status === s.status) return;
    this.seen.set(s.id, {
      id: s.id,
      projectId: s.projectId,
      origin: s.origin,
      automationId: s.automationId,
      runSource: s.runSource,
      status: s.status,
      createdAt: s.createdAt,
      sendId: ev.send?.id ?? held?.sendId ?? null,
    });
    if (ev.send) this.sends.set(ev.send.id, ev.send);
    this.settle(s.id);
  }

  private settle(sessionId: string) {
    const list = this.waiters.get(sessionId);
    const s = this.seen.get(sessionId);
    if (!list || !s || s.status === "running" || s.sendId === null) return;
    const send = this.sends.get(s.sendId);
    if (!send || send.status === "running") return;
    const left = list.filter((w) => {
      const match =
        w.sendId !== null ? send.id === w.sendId : send.id !== w.prev;
      if (match) w.resolve(send.status);
      return !match;
    });
    if (left.length) this.waiters.set(sessionId, left);
    else this.waiters.delete(sessionId);
  }

  // the end of a send: the one named, or with null the first send after
  // prev (a message queued behind a running turn)
  turnEnd(sessionId: string, sendId: string | null, prev: string | null) {
    return new Promise<string>((resolve) => {
      const list = this.waiters.get(sessionId) ?? [];
      list.push({ sendId, prev, resolve, since: now() });
      this.waiters.set(sessionId, list);
      this.settle(sessionId);
    });
  }

  async poll(all: boolean) {
    for (const [sid, list] of [...this.waiters]) {
      if (!all && list.every((w) => now() - w.since < 10 * MIN)) continue;
      const r = await this.api.call<SessionResponse>(
        this.admin,
        "GET",
        `/api/sessions/${sid}`,
      );
      if (r.status !== 200) continue;
      this.envelope({
        type: "session",
        projectId: r.body.session.projectId,
        session: r.body.session,
        messages: [],
        send: r.body.send,
        row: null,
      });
    }
  }

  running() {
    return [...this.seen.values()].filter((s) => s.status === "running");
  }

  // wake every wait, so no turn posts again
  end() {
    this.ending = true;
    for (const list of this.waiters.values()) {
      for (const w of list) w.resolve("ending");
    }
    this.waiters.clear();
  }

  open() {
    const frame = (ev: SocketEvent) => {
      if (ev.type === "session") this.envelope(ev);
    };
    const reopen = (code: number) => {
      this.closes++;
      if (this.ending) return;
      failure("monitor socket closed", { code });
      void sleep(1000)
        .then(() => this.api.socket(this.admin, frame, reopen))
        .then(() => this.poll(true))
        .catch((e) => failure("monitor reopen", { error: String(e) }));
    };
    return this.api.socket(this.admin, frame, reopen);
  }
}
