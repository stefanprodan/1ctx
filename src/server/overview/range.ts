// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The days come as sums by quarter hour of UTC, which every zone's
// midnight falls on, laid on the zone's days by the caller.

import type { DeciderUsage, ModelUsage } from "../../shared/api/admin.ts";
import type { Db } from "../db/index.ts";
import { type DecisionSlot, decisionSlots } from "../usage/index.ts";
import {
  type Bounds,
  byAgents,
  byDeciders,
  byModels,
  byProjects,
  type GroupRow,
} from "./breakdowns.ts";
import { inMemory, ROOT_SEND, SLOT_MS, sizeOf, snapshot } from "./read.ts";

export type RangeInput = {
  now: number;
  // [since, until)
  since: number;
  until: number;
};

// a turn is a send of a chat, a run a send of a task
export type SendSlot = {
  slot: number;
  turns: number;
  turnsFailed: number;
  runs: number;
  runsFailed: number;
};

export type UsageSlot = {
  slot: number;
  prompt: number;
  cached: number;
  completion: number;
  rounds: number;
  priced: number;
  cost: number | null;
};

// oldest first
type Ended = { at: number[]; ms: number[] };

// user is the place in users
type Actives = { users: string[]; slot: number[]; user: number[] };

export type DayReads = {
  readAt: number;
  ended: Ended;
  actives: Actives;
  sends: SendSlot[];
  usage: UsageSlot[];
  decisions: DecisionSlot[];
};

export type RangeResult = DayReads & {
  instance: {
    users: number;
    projects: number;
    agents: number;
    automations: number;
    databaseBytes: number;
  };
};

export type MonthResult = DayReads & {
  since: number | null;
  by: { projects: GroupRow[]; agents: GroupRow[]; models: ModelUsage[] };
  deciders: DeciderUsage[];
};

const SEND_SUMS = `sum(kind != 'run') as turns,
       sum(kind != 'run' and status = 'failed') as turnsFailed,
       sum(kind = 'run') as runs,
       sum(kind = 'run' and status = 'failed') as runsFailed`;

function sendSlots(db: Db, bounds: Bounds): SendSlot[] {
  return db
    .query<SendSlot, Bounds>(
      `select started_at / ${SLOT_MS} as slot, ${SEND_SUMS}
         from sends where started_at >= ? and started_at < ?
           and ${ROOT_SEND("sends")}
         group by slot order by slot`,
    )
    .all(...bounds);
}

const USAGE_SUMS = `sum(prompt_tokens) as prompt,
       sum(coalesce(cached_tokens, 0)) as cached,
       sum(completion_tokens) as completion,
       count(*) as rounds, count(cost) as priced, sum(cost) as cost`;

function usageSlots(db: Db, bounds: Bounds): UsageSlot[] {
  return db
    .query<UsageSlot, Bounds>(
      `select created_at / ${SLOT_MS} as slot, ${USAGE_SUMS}
         from usage where created_at >= ? and created_at < ?
         group by slot order by slot`,
    )
    .all(...bounds);
}

const count = (db: Db, sql: string): number =>
  db.query<{ n: number }, []>(sql).get()!.n;

function instance(db: Db): RangeResult["instance"] {
  const memory = inMemory(db);
  return {
    users: count(db, "select count(*) as n from users"),
    projects: count(
      db,
      "select count(*) as n from projects where kind = 'team'",
    ),
    agents: count(
      db,
      "select count(*) as n from agents where deleted_at is null",
    ),
    automations: count(db, "select count(*) as n from automations"),
    databaseBytes: memory
      ? 0
      : sizeOf(db.filename) + sizeOf(`${db.filename}-wal`),
  };
}

// a run's length is its task's; a clock stepped back reads as zero long
function ended(db: Db, bounds: Bounds): Ended {
  const rows = db
    .query<{ at: number; ms: number }, Bounds>(
      `select started_at as at, max(finished_at - started_at, 0) as ms
         from sends
         where kind != 'run' and status != 'running'
           and finished_at is not null
           and started_at >= ? and started_at < ?
           and ${ROOT_SEND("sends")}
         order by started_at`,
    )
    .all(...bounds);
  return { at: rows.map((r) => r.at), ms: rows.map((r) => r.ms) };
}

function actives(db: Db, bounds: Bounds): Actives {
  const rows = db
    .query<{ user: string; slot: number }, Bounds>(
      `select user_id as user, started_at / ${SLOT_MS} as slot
         from sends where started_at >= ? and started_at < ?
           and ${ROOT_SEND("sends")}
         group by user, slot order by slot`,
    )
    .all(...bounds);
  const users: string[] = [];
  const place = new Map<string, number>();
  const out: Actives = { users, slot: [], user: [] };
  for (const row of rows) {
    let at = place.get(row.user);
    if (at === undefined) {
      at = users.push(row.user) - 1;
      place.set(row.user, at);
    }
    out.slot.push(row.slot);
    out.user.push(at);
  }
  return out;
}

function dayReads(db: Db, input: RangeInput, days: Bounds): DayReads {
  return {
    readAt: input.now,
    ended: ended(db, days),
    actives: actives(db, days),
    sends: sendSlots(db, days),
    usage: usageSlots(db, days),
    decisions: decisionSlots(db, input.since, input.until, SLOT_MS),
  };
}

export function range(db: Db, input: RangeInput): RangeResult {
  return snapshot(db, () => ({
    ...dayReads(db, input, [input.since, input.until]),
    instance: instance(db),
  }));
}

export function month(db: Db, input: RangeInput): MonthResult {
  return snapshot(db, () => {
    const days: Bounds = [input.since, input.until];
    return {
      ...dayReads(db, input, days),
      since: db
        .query<{ since: number | null }, []>(
          "select min(started_at) as since from sends",
        )
        .get()!.since,
      by: {
        projects: byProjects(db, days),
        agents: byAgents(db, days),
        models: byModels(db, days),
      },
      deciders: byDeciders(db, days),
    };
  });
}
