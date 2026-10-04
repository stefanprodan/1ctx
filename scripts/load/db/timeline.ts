// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The history written hour by hour, in the order the app wrote it:
// chat turns and their compactions, every automation's runs (retention
// keeps 30 days, the rest leaves its usage).

import { int, pick, rng } from "../random.ts";
import type { Automation, Build } from "./context.ts";
import type { ChatPlan, History, Item } from "./history.ts";
import { hash } from "./ids.ts";
import {
  ARCHIVED_DELETE_DAYS,
  DAY,
  HOUR,
  LAST_SWEEP,
  MIN,
  NOW,
  RETENTION_DAYS,
  SCRATCH_IDLE_DAYS,
} from "./presets.ts";
import { writeTurn } from "./sends.ts";
import {
  type Ctx,
  cutAt,
  shape,
  shapeMs,
  shapeRounds,
  usage,
  usageOnly,
} from "./shape.ts";
import { NOTES, SCRATCH, SUMMARY } from "./tools.ts";

// an incident's RCA and the runbook it updated, written after the turns
export type KnowledgeWrite = {
  project: string;
  at: number;
  plan: ChatPlan;
  rca: number;
  runbook: number;
};

export type Timeline = {
  knowledgeWrites: KnowledgeWrite[];
  running: { runs: string[]; chats: string[]; incident: string };
  sample: {
    archivedChat: string;
    liveChat: string;
    run: string;
    orphanRun: string;
  };
};

export function writeTimeline(b: Build, h: History): Timeline {
  const { q, teams, clock } = b;
  const tl: Timeline = {
    knowledgeWrites: [],
    running: { runs: [], chats: [], incident: "" },
    sample: { archivedChat: "", liveChat: "", run: "", orphanRun: "" },
  };
  const fresh = (plan: ChatPlan, pack: boolean): Ctx => ({
    id: plan.id,
    project: plan.project,
    agent: plan.agent,
    seq: 0,
    context: 24_000,
    folders: 0,
    pack,
  });
  const writes = (plan: ChatPlan, at: number, r: () => number) => {
    tl.knowledgeWrites.push({
      project: plan.project,
      at,
      plan,
      rca: int(r, 0, 31),
      runbook: int(r, 0, 149),
    });
  };

  function startSession(plan: ChatPlan) {
    plan.ctx = fresh(plan, plan.archivedAt !== null && !plan.inflight);
    q.session.run(
      plan.id,
      plan.project,
      plan.owner.id,
      plan.agent.id,
      "chat",
      null,
      plan.title,
      plan.status,
      plan.revision,
      plan.created,
      plan.last,
      null,
      0,
      plan.archivedAt,
      plan.archivedBy,
      plan.archivedReason,
      null,
      null,
    );
    b.bump("sessions");
    b.bump(plan.profile === "incident" ? "sessions_incident" : "sessions_chat");
    if (plan.archivedAt !== null) b.bump("sessions_archived");
    if (plan.inflight) {
      if (plan.profile === "incident") tl.running.incident = plan.id;
      else tl.running.chats.push(plan.id);
    }
    if (
      plan.archivedAt !== null &&
      tl.sample.archivedChat === "" &&
      plan.profile === "chat"
    ) {
      tl.sample.archivedChat = plan.id;
    }
  }

  function chatTurn({ plan, i }: Item) {
    const turn = plan.turns[i]!;
    const last = i === plan.turns.length - 1;
    const s = shape(turn.seed, plan.profile);
    if (plan.deleted) {
      plan.ctx ??= fresh(plan, false);
      const end = usageOnly(
        b,
        plan.ctx,
        s,
        rng(turn.seed ^ 0x51ed),
        turn.author,
        turn.t,
      );
      if (last) {
        b.bump(
          plan.profile === "incident" ? "incidents_deleted" : "chats_deleted",
        );
        if (plan.profile === "incident") {
          const seed = plan.turns[0]!.seed;
          tl.knowledgeWrites.push({
            project: plan.project,
            at: end,
            plan,
            rca: int(rng(seed), 0, 31),
            runbook: int(rng(seed + 1), 0, 149),
          });
        }
        plan.ctx = null;
      }
      return;
    }
    if (i === 0) startSession(plan);
    const ctx = plan.ctx!;
    const inflight = plan.inflight && last ? cutAt(turn.t, s) : null;
    const r = rng(turn.seed ^ 0x51ed);
    const out = writeTurn(
      b,
      ctx,
      plan.profile,
      "chat",
      s,
      r,
      turn.author,
      turn.t,
      turn.text,
      inflight,
    );
    if (turn.compact) {
      // a compaction: its own send, one summary row, the context reset
      const send = b.newId();
      const mid = b.newId();
      const at = out.end + 5_000;
      const summary = pick(r, SUMMARY);
      const a = ctx.agent;
      q.send.run(
        send,
        ctx.id,
        "compact",
        turn.author.id,
        a.id,
        a.provider.id,
        a.provider.name,
        a.model,
        "done",
        "finish",
        null,
        mid,
        1,
        0,
        at,
        at + 40_000,
        null,
        null,
      );
      q.message.run(
        mid,
        ctx.id,
        ++ctx.seq,
        "summary",
        send,
        1,
        null,
        null,
        a.id,
        summary,
        "",
        "",
        "done",
        null,
        "stop",
        null,
        null,
        null,
        a.model,
        900,
        null,
        at,
        at + 40_000,
        null,
        null,
      );
      b.bump("sends");
      b.bump("messages");
      usage(b, ctx, send, turn.author.id, 1, ctx.seq, at, r, 0);
      ctx.context = 24_000 + Math.ceil(summary.length / 4);
    }
    if (last) closeChat(plan, out.end);
  }

  function closeChat(plan: ChatPlan, end: number) {
    const ctx = plan.ctx!;
    const r = rng(hash(plan.turns[0]!.seed, 0x5c));
    if (ctx.folders > 0) {
      b.db
        .query("update sessions set mcp_folders = ? where id = ?")
        .run(ctx.folders, ctx.id);
    }
    if (plan.archivedAt === null) {
      // a live chat: its memory view, and /tmp while it was used this week
      const note = pick(r, NOTES);
      q.view.run(ctx.id, note, note);
      b.bump("memory_views");
      const recent = plan.last > NOW - SCRATCH_IDLE_DAYS * DAY;
      if (recent && (plan.profile === "incident" || r() < 0.8)) {
        const incident = plan.profile === "incident";
        const files = incident ? int(r, 5, 15) : int(r, 1, 3);
        let bytes = 0;
        for (let f = 0; f < files; f++) {
          const size = incident
            ? int(r, 50_000, 900_000)
            : 2_000 + Math.floor(r() ** 12 * 1_000_000);
          const data = Buffer.from(pick(r, SCRATCH).slice(0, size));
          const name = pick(r, ["pods", "events", "logs", "diff", "report"]);
          q.scratchFile.run(ctx.id, `${name}-${f}.txt`, data);
          bytes += size;
        }
        q.scratch.run(
          ctx.id,
          files * 2,
          bytes,
          files,
          Math.min(plan.last + 60_000, NOW),
        );
        b.bump("session_scratch");
        b.bump("session_scratch_files", files);
      }
      if (
        tl.sample.liveChat === "" &&
        plan.profile === "chat" &&
        !plan.inflight
      ) {
        tl.sample.liveChat = ctx.id;
      }
    }
    if (plan.profile === "incident" && !plan.inflight) writes(plan, end, r);
    plan.ctx = null;
  }

  function run(a: Automation, at: number, hour: number) {
    const r = rng(hash(a.index, hour, 0x2a));
    const manual = r() < 0.02;
    const runner = manual ? pick(r, teams[a.team]!.members) : a.owner;
    const s = shape(hash(a.index, hour), "run", a.ownMemory);
    // retention keeps 30 days; a deleted automation kept its runs, if
    // asked to, and the chats sweep takes those a year after
    const retained =
      a.id !== null
        ? at >= LAST_SWEEP - RETENTION_DAYS * DAY
        : a.keepOrphans &&
          at >= a.stopAt! - RETENTION_DAYS * DAY &&
          at >= LAST_SWEEP - ARCHIVED_DELETE_DAYS * DAY;
    const ctx: Ctx = {
      id: b.newId(),
      project: teams[a.team]!.id,
      agent: a.agent,
      seq: 0,
      context: 24_000,
      folders: 0,
      pack: false,
    };
    const isRunning = a.running && at > NOW - 10 * MIN;
    a.lastFire = at;
    const decide = (end: number) => {
      q.decision.run(
        b.newId(),
        b.decider,
        b.provider.id,
        ctx.id,
        ctx.project,
        int(r, 600, 4000),
        int(r, 1, 30) / 1e6,
        int(r, 300, 1500),
        end + 1000,
      );
      b.bump("decision_usage");
    };
    if (!retained) {
      // swept by retention long ago: only its usage and attention ask stay
      const end = usageOnly(b, ctx, s, r, runner, at);
      b.bump("runs_swept");
      if (s.outcome === "done") decide(end);
      return;
    }
    const end0 = at + shapeMs(s);
    ctx.pack = !isRunning && end0 < LAST_SWEEP;
    const revision = 2 + 3 * shapeRounds(s);
    const status = isRunning ? "running" : s.outcome;
    const attention =
      status !== "done"
        ? null
        : r() < 0.85
          ? int(r, 0, 20) / 100
          : r() < 0.66
            ? int(r, 20, 70) / 100
            : int(r, 70, 100) / 100;
    q.session.run(
      ctx.id,
      ctx.project,
      runner.id,
      a.agent.id,
      "automation",
      a.id,
      a.name,
      status,
      revision,
      at,
      isRunning ? at : end0,
      manual ? "manual" : "schedule",
      0,
      null,
      null,
      null,
      attention,
      attention === null ? null : "fake-decider",
    );
    b.bump("sessions");
    b.bump("sessions_run");
    if (a.id === null) b.bump("sessions_orphan_run");
    const out = writeTurn(
      b,
      ctx,
      "run",
      "run",
      s,
      r,
      runner,
      at,
      a.instructions,
      isRunning ? cutAt(at, s) : null,
    );
    if (out.status === "done") decide(out.end);
    if (isRunning) tl.running.runs.push(ctx.id);
    else if (tl.sample.run === "" && at > NOW - 2 * DAY) tl.sample.run = ctx.id;
    if (a.id === null && tl.sample.orphanRun === "")
      tl.sample.orphanRun = ctx.id;
    if (a.id !== null) {
      a.lastRun = { id: ctx.id, status, at: isRunning ? at : out.end };
    }
  }

  let lastLog = performance.now();
  for (let hour = 0; hour <= clock.hours; hour++) {
    const hourStart = clock.start + hour * HOUR;
    type Entry = { t: number; chat: Item } | { t: number; run: Automation };
    const items: Entry[] = [];
    for (const item of h.buckets[hour]!) items.push({ t: item.t, chat: item });
    for (const a of b.automations) {
      const at = hourStart + a.offset;
      if (at > NOW) continue;
      if (a.stopAt !== null && at >= a.stopAt) continue;
      items.push({ t: at, run: a });
    }
    items.sort((x, y) => x.t - y.t);
    for (const it of items) {
      if ("chat" in it) chatTurn(it.chat);
      else run(it.run, it.t, hour);
    }
    h.buckets[hour] = [];
    if (hour % 24 === 23 && performance.now() - lastLog > 10_000) {
      lastLog = performance.now();
      const c = b.count;
      b.log(
        `day ${Math.floor(hour / 24) + 1}/${clock.historyDays}: ${c.sessions ?? 0} sessions, ${c.messages ?? 0} messages, ${c.usage ?? 0} usage`,
      );
    }
  }
  return tl;
}
