// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A signed-in user on Home or a project's feed, kept as the page keeps
// it (client/data/feed.ts): a held row moves in place, a chat's
// envelope carrying its row is inserted, and only a row the server
// alone can place (a run's line, a row-less envelope) asks for the
// first page again, through the client's own Flight: one load out, a
// pause after it, then the one trailing load. A watcher also opens a
// chat now and then, or the turn its user just started, and times the
// stream frames it gets.

import { Flight } from "../../../src/client/data/flight.ts";
import type { SessionsResponse } from "../../../src/shared/api/sessions.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import type { Api, Who } from "./api.ts";
import { failure, sleep } from "./log.ts";

type Envelope = Extract<SocketEvent, { type: "session" }>;

export const watch = {
  feedInitial: [] as number[],
  feedRefresh: [] as number[],
  feedFailed: 0,
  frames: {} as Record<string, number>,
  bytes: 0,
  closes: 0,
  watches: 0,
  // the longest gap between two deltas of one message
  deltaGaps: [] as number[],
  // a «ms» marker in a delta against the time it arrived
  relay: [] as number[],
  // a post against the first delta of its turn
  firstDelta: [] as number[],
};

export class Watcher {
  private held = new Set<string>();
  private lines = new Set<string>();
  private loaded = false;
  private ws: WebSocket | null = null;
  private watching: string | null = null;
  private posted = new Map<string, number>();
  private lastDelta = new Map<string, { at: number; max: number }>();
  private readonly flight: Flight;
  stopped = false;

  constructor(
    private readonly api: Api,
    readonly who: Who,
    readonly project: string | null,
    // opens a running chat now and then, with this share
    private readonly looks: number,
    private readonly rand: () => number,
  ) {
    this.flight = new Flight(() => this.load(false));
  }

  private covers(projectId: string) {
    return this.project === null || this.project === projectId;
  }

  private async load(initial: boolean) {
    const t = performance.now();
    const path =
      this.project === null
        ? "/api/sessions"
        : `/api/sessions?project=${this.project}`;
    const r = await this.api.call<SessionsResponse>(this.who, "GET", path);
    (initial ? watch.feedInitial : watch.feedRefresh).push(
      performance.now() - t,
    );
    if (r.status !== 200) {
      watch.feedFailed++;
      return;
    }
    this.held = new Set(r.body.rows.map((row) => row.session.id));
    this.lines = new Set(
      r.body.rows
        .map((row) => row.automation?.id ?? row.session.automationId ?? "")
        .filter((x) => x !== ""),
    );
    this.loaded = true;
  }

  private envelope(ev: Envelope) {
    if (!this.covers(ev.projectId)) return;
    const s = ev.session;
    if (this.looks > 0) this.look(ev);
    if (
      this.watching === s.id &&
      s.status !== "running" &&
      this.posted.size === 0
    ) {
      this.unwatch();
    }
    if (!this.loaded || this.held.has(s.id)) return;
    // All shows one line per automation, its newest run
    const grouped = s.origin === "automation" && s.automationId !== null;
    if (grouped && this.lines.has(s.automationId!)) {
      this.held.add(s.id);
      return;
    }
    if (ev.row === null || grouped) {
      this.flight.ask();
      return;
    }
    this.held.add(s.id);
  }

  // a member opens a running chat now and then, and leaves when it ends
  private look(ev: Envelope) {
    const s = ev.session;
    if (this.watching !== null || this.stopped) return;
    if (s.origin !== "chat" || s.status !== "running") return;
    if (this.rand() > this.looks) return;
    this.open(s.id);
  }

  private open(sessionId: string) {
    this.watching = sessionId;
    watch.watches++;
    this.ws?.send(JSON.stringify({ type: "watch", sessionId }));
  }

  private unwatch() {
    if (this.watching === null) return;
    this.ws?.send(
      JSON.stringify({ type: "unwatch", sessionId: this.watching }),
    );
    this.watching = null;
  }

  // the user opens the chat of the turn they just posted
  follow(sessionId: string, postedAt: number) {
    if (this.watching !== null && this.watching !== sessionId) this.unwatch();
    this.posted.set(sessionId, postedAt);
    if (this.watching !== sessionId) this.open(sessionId);
  }

  leave(sessionId: string) {
    this.posted.delete(sessionId);
    if (this.watching === sessionId) this.unwatch();
  }

  private frame(ev: SocketEvent, raw: string) {
    watch.frames[ev.type] = (watch.frames[ev.type] ?? 0) + 1;
    watch.bytes += raw.length;
    if (ev.type === "session") this.envelope(ev);
    else if (ev.type === "delta") {
      const t = performance.now();
      const posted = this.posted.get(ev.sessionId);
      if (posted !== undefined && posted > 0) {
        watch.firstDelta.push(t - posted);
        this.posted.set(ev.sessionId, 0);
      }
      for (const m of (ev.content ?? "").matchAll(/«(\d+)»/g)) {
        watch.relay.push(Date.now() - Number(m[1]));
      }
      const last = this.lastDelta.get(ev.messageId);
      if (last) {
        last.max = Math.max(last.max, t - last.at);
        last.at = t;
      } else this.lastDelta.set(ev.messageId, { at: t, max: 0 });
    }
  }

  async connect() {
    this.ws = await this.api.socket(
      this.who,
      (ev, raw) => this.frame(ev, raw),
      (code) => {
        if (this.stopped) return;
        watch.closes++;
        failure("watcher socket closed", { user: this.who.user, code });
        this.watching = null;
        // the client opens again and loads cold
        void sleep(2000)
          .then(() => this.connect())
          .catch(() => {});
      },
    );
    await this.flight.run(() => this.load(true));
  }

  close() {
    this.stopped = true;
    this.flight.stop();
    for (const { max } of this.lastDelta.values()) {
      if (max > 0) watch.deltaGaps.push(max);
    }
    this.lastDelta.clear();
    this.ws?.close();
  }
}
