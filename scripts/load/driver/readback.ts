// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// After a step: what the watchers saw, every send started in the step
// read back (a `send` event each, with its lateness against its due
// time for a run), every due fire as the automations' rows tell it (a
// skipped or waiting fire shows there and nowhere in the sends), and
// the step's `summary`.

import type { SessionResponse } from "../../../src/shared/api/sessions.ts";
import type { Api, Who } from "./api.ts";
import { teamAutomations } from "./automations.ts";
import type { Directory } from "./directory.ts";
import { failure, MIN, out, pool, stats } from "./log.ts";
import type { Monitor } from "./monitor.ts";
import { watch } from "./watchers.ts";

export type StepRecord = {
  mult: number;
  minutes: number;
  T0: number;
  prepAt: number;
  chatCount: number;
  due: Map<string, number>;
  pressedAt: Map<string, number>;
  incidentSessions: string[];
  refused: Record<string, number>;
  stopped: number;
  lag: number[];
  watchers: number;
  admins: number;
  monitorCloses: number;
};

export function watcherEvent(
  step: number,
  sockets: number,
  admins: number,
  lag: number[],
  monitorCloses: number,
) {
  out({
    t: "watchers",
    step,
    sockets,
    admins,
    feedGets: watch.feedInitial.length + watch.feedRefresh.length,
    feedInitial: stats(watch.feedInitial),
    feedRefresh: stats(watch.feedRefresh),
    feedFailed: watch.feedFailed,
    frames: watch.frames,
    mb: +(watch.bytes / 1e6).toFixed(1),
    closes: watch.closes,
    watches: watch.watches,
    deltaGapPerMessage: stats(watch.deltaGaps),
    relay: stats(watch.relay),
    firstDelta: stats(watch.firstDelta),
    driverLag: stats(lag),
    monitorCloses,
  });
}

export async function readBack(
  api: Api,
  admin: Who,
  d: Directory,
  monitor: Monitor,
  s: StepRecord,
) {
  const step = s.mult;
  watcherEvent(step, s.watchers, s.admins, s.lag, s.monitorCloses);
  const teamName = (id: string) => d.teamById.get(id)?.name ?? id;
  const kindOf = (id: string, origin: string) =>
    origin === "automation"
      ? "run"
      : s.incidentSessions.includes(id)
        ? "incident"
        : "chat";
  const tally: Record<string, number> = {};
  const late: number[] = [];
  const turnMs: Record<string, number[]> = { chat: [], run: [], incident: [] };
  await pool([...monitor.seen.values()], 4, async (seen) => {
    const r = await api.call<SessionResponse>(
      admin,
      "GET",
      `/api/sessions/${seen.id}`,
    );
    if (r.status !== 200) {
      failure("read back", {
        session: seen.id,
        status: r.status,
        error: r.error,
      });
      return;
    }
    const detail = r.body;
    if (detail.send) monitor.sends.set(detail.send.id, detail.send);
    const kind = kindOf(seen.id, seen.origin);
    const bySend = new Map<
      string,
      { start: number; end: number | null; marker: string | null }
    >();
    for (const m of detail.messages) {
      const e = bySend.get(m.sendId) ?? {
        start: m.createdAt,
        end: null,
        marker: null,
      };
      e.start = Math.min(e.start, m.createdAt);
      if (m.finishedAt !== null) e.end = Math.max(e.end ?? 0, m.finishedAt);
      if (m.kind === "user" && e.marker === null) {
        e.marker = /#([A-Za-z0-9-]+)/.exec(m.content)?.[1] ?? null;
      }
      bySend.set(m.sendId, e);
    }
    for (const [sendId, e] of bySend) {
      const send = monitor.sends.get(sendId);
      const start = send?.startedAt ?? e.start;
      if (start < s.prepAt) continue;
      const finished = send?.finishedAt ?? e.end;
      const source = kind === "run" ? detail.session.runSource : null;
      const dueAt =
        kind !== "run"
          ? null
          : source === "manual"
            ? (s.pressedAt.get(seen.id) ?? null)
            : (s.due.get(detail.session.automationId ?? "") ?? null);
      const lateMs =
        dueAt !== null && Math.abs(start - dueAt) < 360 * MIN
          ? start - dueAt
          : null;
      const status =
        send?.status ?? (finished === null ? "running" : "unknown");
      tally[`${kind}:${status}`] = (tally[`${kind}:${status}`] ?? 0) + 1;
      if (lateMs !== null && source === "schedule") late.push(lateMs);
      if (finished !== null && status === "done")
        turnMs[kind]!.push(finished - start);
      out({
        t: "send",
        step,
        kind,
        session: seen.id,
        send: sendId,
        marker: e.marker,
        project: teamName(detail.session.projectId),
        user: d.userById.get(send?.userId ?? "") ?? null,
        automation: detail.session.automationId,
        source,
        due: dueAt,
        start,
        end: finished,
        status,
        cause: send?.cause ?? null,
        error: send?.error ?? null,
        rounds: send?.rounds ?? null,
        toolCalls: send?.toolCalls ?? null,
        lateMs,
        durMs: finished === null ? null : finished - start,
      });
    }
  });

  const after = await teamAutomations(api, admin, d);
  const fires: Record<string, number> = {};
  for (const a of after.values()) {
    const dueAt = s.due.get(a.id);
    if (dueAt === undefined) continue;
    const outcome =
      a.lastEventDueAt === dueAt ? (a.lastEventOutcome ?? "none") : "not fired";
    fires[outcome] = (fires[outcome] ?? 0) + 1;
    out({
      t: "fire",
      step,
      automation: a.id,
      name: a.name,
      project: teamName(a.projectId),
      due: dueAt,
      eventDue: a.lastEventDueAt,
      eventAt: a.lastEventAt,
      outcome,
      reason: a.lastEventReason,
      lastRun: a.lastRunStatus,
    });
  }

  out({
    t: "summary",
    mode: "step",
    step,
    minutes: s.minutes,
    t0: s.T0,
    chatsPlanned: s.chatCount,
    sends: tally,
    refused: s.refused,
    fires,
    lateness: stats(late),
    turnMs: {
      chat: stats(turnMs.chat!),
      run: stats(turnMs.run!),
      incident: stats(turnMs.incident!),
    },
    stopped: s.stopped,
  });
}
