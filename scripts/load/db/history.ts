// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chats of the history, planned before a row is written: two a
// user a working day in working hours, the chats with a turn running
// now, and an incident every few hours in some team project, compacted
// as it grows, the newest with a turn in flight. Each turn lands in the
// hour bucket it starts in, for the timeline to write in order.

import { int, pick, rng, weighted } from "../random.ts";
import type { Agent, Build, User } from "./context.ts";
import { hash } from "./ids.ts";
import { agentAt, teamsOf } from "./people.ts";
import {
  ARCHIVE_IDLE_DAYS,
  ARCHIVED_DELETE_DAYS,
  DAY,
  HOUR,
  LAST_SWEEP,
  MIN,
  NOW,
} from "./presets.ts";
import {
  type Ctx,
  type Profile,
  shape,
  shapeMs,
  shapeRounds,
} from "./shape.ts";
import { APPS } from "./text.ts";
import { TITLES, USER_CHAT, USER_INCIDENT } from "./tools.ts";

export type ChatPlan = {
  id: string;
  profile: Profile;
  project: string;
  owner: User;
  agent: Agent;
  title: string;
  turns: {
    t: number;
    seed: number;
    author: User;
    compact: boolean;
    text: string;
  }[];
  status: string;
  last: number;
  archivedAt: number | null;
  archivedReason: string | null;
  archivedBy: string | null;
  revision: number;
  inflight: boolean;
  members: User[];
  team: number | null;
  ctx: Ctx | null;
  created: number;
  // archived longer than the chats sweep keeps: only its usage is left
  deleted: boolean;
};

export type Item = { t: number; plan: ChatPlan; i: number };

export type History = {
  chats: ChatPlan[];
  incidents: ChatPlan[];
  // the turns by the hour they start in
  buckets: Item[][];
};

// a send's length, to place the next one after it
const turnMs = (seed: number, profile: Profile) =>
  shapeMs(shape(seed, profile));

export const RCA_TURN =
  "Write the RCA to /knowledge/incidents and update the runbook.";

export function planHistory(b: Build): History {
  const { preset: P, clock, users, teams, liveAgents } = b;
  const h: History = {
    chats: [],
    incidents: [],
    buckets: Array.from({ length: clock.hours + 1 }, () => []),
  };
  const bucketOf = (t: number) =>
    Math.min(clock.hours, Math.max(0, Math.floor((t - clock.start) / HOUR)));

  function finish(plan: ChatPlan) {
    let revision = 0;
    let status = "done";
    let last = plan.turns[0]!.t;
    for (const turn of plan.turns) {
      const s = shape(turn.seed, plan.profile);
      revision += 2 + 3 * shapeRounds(s);
      status = s.outcome;
      last = turn.t + shapeMs(s);
    }
    if (plan.inflight) {
      status = "running";
      last = plan.turns.at(-1)!.t;
    }
    plan.status = status;
    plan.last = last;
    plan.revision = revision + plan.turns.filter((x) => x.compact).length * 3;
    // archived: by the idle sweep, by hand, or with its agent
    if (!plan.inflight) {
      const idleAt = last + ARCHIVE_IDLE_DAYS * DAY;
      const r = rng(hash(plan.turns[0]!.seed, 7));
      const retired = plan.agent.retiredAt;
      if (retired !== null && retired < Math.min(idleAt, LAST_SWEEP)) {
        plan.archivedAt = retired;
        plan.archivedReason = "agent";
      } else if (r() < 0.05 && last + 2 * HOUR < NOW - HOUR) {
        plan.archivedAt = Math.min(NOW - HOUR, last + int(r, 1, 240) * HOUR);
        plan.archivedReason = "manual";
        plan.archivedBy = r() < 0.8 ? plan.owner.id : pick(r, plan.members).id;
      } else if (idleAt < LAST_SWEEP) {
        plan.archivedAt =
          LAST_SWEEP - Math.floor((LAST_SWEEP - idleAt) / HOUR) * HOUR;
        plan.archivedReason = "idle";
      }
      if (plan.archivedAt !== null) plan.revision++;
      plan.deleted =
        plan.archivedAt !== null &&
        plan.archivedAt < LAST_SWEEP - ARCHIVED_DELETE_DAYS * DAY;
    }
    for (const [i, turn] of plan.turns.entries()) {
      h.buckets[bucketOf(turn.t)]!.push({ t: turn.t, plan, i });
    }
    h.chats.push(plan);
  }

  function chatPlan(
    profile: Profile,
    owner: User,
    team: number | null,
    created: number,
    seed: number,
  ): ChatPlan {
    const r = rng(seed);
    const members = team === null ? [owner] : teams[team]!.members;
    const picked = owner.pick === null ? null : liveAgents[owner.pick]!;
    const agent =
      profile === "incident"
        ? agentAt(b, r, created, true)
        : picked !== null && r() < 0.7 && picked.retiredAt === null
          ? picked
          : agentAt(b, r, created);
    const title =
      profile === "incident"
        ? `incident: ${pick(r, APPS)}-api ${pick(r, ["502s", "crash loop", "latency", "OOMKilled", "failed rollout"])}`
        : pick(r, TITLES);
    return {
      id: b.newId(),
      profile,
      project: team === null ? owner.personal : teams[team]!.id,
      owner,
      agent,
      title,
      turns: [],
      status: "done",
      last: created,
      archivedAt: null,
      archivedReason: null,
      archivedBy: null,
      revision: 0,
      inflight: false,
      members,
      team,
      ctx: null,
      created,
      deleted: false,
    };
  }

  // chats: two per user per working day, in working hours
  for (let d = 0; d < clock.historyDays; d++) {
    const dayStart = clock.start + d * DAY;
    const wd = new Date(dayStart).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const [ui, u] of users.entries()) {
      const r = rng(hash(d, ui, 0xc1));
      const n = weighted(r, [
        [0, 10],
        [1, 25],
        [2, 35],
        [3, 20],
        [4, 10],
      ] as const);
      for (let c = 0; c < n; c++) {
        const created = dayStart + 7 * HOUR + Math.floor(r() * 11 * HOUR);
        if (created > NOW - 30 * MIN) continue;
        const mine = teamsOf(b, u);
        const team = r() < 0.6 && mine.length > 0 ? pick(r, mine) : null;
        const plan = chatPlan("chat", u, team, created, hash(d, ui, c));
        const turns = weighted(r, [
          [1, 25],
          [2, 20],
          [3, 18],
          [4, 12],
          [5, 9],
          [6, 7],
          [7, 5],
          [8, 4],
        ] as const);
        let t = created;
        for (let k = 0; k < turns; k++) {
          const seed = hash(d, ui, c, k);
          const ms = turnMs(seed, "chat");
          if (t + ms > NOW - 10 * MIN) break;
          const retired = plan.agent.retiredAt;
          if (retired !== null && t + ms > retired) break;
          const author =
            team !== null && k > 0 && r() < 0.15 ? pick(r, plan.members) : u;
          plan.turns.push({
            t,
            seed,
            author,
            compact: false,
            text: pick(r, USER_CHAT),
          });
          t +=
            ms +
            (r() < 0.7 ? int(r, 30_000, 1_800_000) : int(r, HOUR, 3 * DAY));
        }
        if (plan.turns.length > 0) finish(plan);
      }
    }
  }

  // chats with a send running now
  for (let c = 0; c < P.runningChats; c++) {
    const r = rng(hash(c, 0x7c));
    const u = users[int(r, 0, users.length - 1)]!;
    const mine = teamsOf(b, u);
    const team = r() < 0.6 && mine.length > 0 ? pick(r, mine) : null;
    const created = NOW - int(r, 10, 90) * MIN;
    const plan = chatPlan("chat", u, team, created, hash(c, 0x7d));
    const turns = int(r, 1, 3);
    let t = created;
    let end = created;
    for (let k = 0; k < turns - 1; k++) {
      const seed = hash(c, k, 0x7e);
      const ms = turnMs(seed, "chat");
      if (t + ms > NOW - 7 * MIN) break;
      plan.turns.push({
        t,
        seed,
        author: u,
        compact: false,
        text: pick(r, USER_CHAT),
      });
      end = t + ms;
      t = end + int(r, 30_000, 120_000);
    }
    const start = Math.min(
      NOW - 5_000,
      Math.max(end + 30_000, NOW - int(r, 20, 360) * 1000),
    );
    plan.turns.push({
      t: start,
      seed: hash(c, 0x7e),
      author: u,
      compact: false,
      text: pick(r, USER_CHAT),
    });
    plan.inflight = true;
    finish(plan);
  }

  // incidents: about an hour of turns with the on-call dev and others
  // joining, compacted twice, an RCA at the end
  function incidentPlan(start: number, seed: number, inflight: boolean) {
    const r = rng(seed);
    const team = int(r, 0, teams.length - 1);
    const oncall = pick(r, teams[team]!.members);
    const plan = chatPlan("incident", oncall, team, start, seed);
    const helpers = [
      oncall,
      ...Array.from({ length: int(r, 1, 3) }, () =>
        pick(r, teams[team]!.members),
      ),
    ];
    if (r() < 0.5) helpers.push(users[int(r, 0, P.admins - 1)]!);
    const turns = int(r, 16, 24);
    let t = start;
    let end = start;
    for (let k = 0; k < turns; k++) {
      const tseed = hash(seed, k);
      const ms = turnMs(tseed, "incident");
      const lastTurn = k === turns - 1;
      if (inflight && t + ms > NOW) {
        const at = Math.min(
          NOW - 5_000,
          Math.max(end + 10_000, Math.min(t, NOW - 20_000)),
        );
        plan.turns.push({
          t: at,
          seed: tseed,
          author: pick(r, helpers),
          compact: false,
          text: pick(r, USER_INCIDENT),
        });
        plan.inflight = true;
        break;
      }
      if (!inflight && t + ms > NOW - 2 * MIN) break;
      const retired = plan.agent.retiredAt;
      if (retired !== null && t + ms > retired) break;
      end = t + ms;
      plan.turns.push({
        t,
        seed: tseed,
        author: k === 0 ? oncall : pick(r, helpers),
        compact: k === 8 || k === 15,
        text: lastTurn ? RCA_TURN : pick(r, USER_INCIDENT),
      });
      t += ms + int(r, 15_000, 90_000);
    }
    if (inflight && !plan.inflight) {
      // it ran out of turns before now: one more, in flight
      const at = Math.min(NOW - 5_000, Math.max(end + 10_000, NOW - 2 * MIN));
      plan.turns.push({
        t: at,
        seed: hash(seed, 99),
        author: oncall,
        compact: false,
        text: pick(r, USER_INCIDENT),
      });
      plan.inflight = true;
    }
    finish(plan);
    h.incidents.push(plan);
  }
  const inflightStart = NOW - 45 * MIN;
  for (let hour = 0; hour < clock.hours; hour += P.incidentEvery) {
    const start =
      clock.start + hour * HOUR + int(rng(hash(hour, 0x1c)), 0, 50) * MIN;
    if (start > inflightStart - 30 * MIN) break;
    incidentPlan(start, hash(hour, 0x1d), false);
  }
  incidentPlan(inflightStart, hash(0x1f), true);
  return h;
}
