// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview's days and all time: every query the answer needs over
// one connection, read once in one transaction and shaped into plain
// data the worker can post. The days come as sums by quarter hour of
// UTC, which every zone's midnight falls on, laid on the zone's days by
// the caller; the breakdowns and the models take the days' bounds. A
// send has many usage rows, so sends and tokens are summed from their
// own table each and joined by key afterwards, never in one query.

import { statSync } from "node:fs";
import type { Db } from "../db/index.ts";

export type RangeInput = {
  now: number;
  // the slots, the breakdowns and the lengths cover [since, until)
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

// one row of a breakdown before its top is taken: the key that groups
// it, the names the answer draws, and its sums
export type GroupRow = {
  key: string;
  id: string | null;
  name: string | null;
  owner: string | null;
  tokens: number;
  turns: number;
  runs: number;
};

export type ModelRow = {
  provider: string;
  model: string;
  turns: number;
  // the lengths of the ended turns
  lengths: number[];
};

export type AllTime = Omit<SendSlot, "slot"> &
  Omit<UsageSlot, "slot"> & { since: number | null };

export type RangeResult = {
  readAt: number;
  sends: SendSlot[];
  usage: UsageSlot[];
  by: { projects: GroupRow[]; agents: GroupRow[] };
  models: ModelRow[];
  all: AllTime;
  instance: {
    users: number;
    projects: number;
    agents: number;
    automations: number;
    databaseBytes: number;
  };
};

export const SLOT_MS = 900_000;

type Bounds = [number, number];

const SEND_SUMS = `sum(kind != 'run') as turns,
       sum(kind != 'run' and status = 'failed') as turnsFailed,
       sum(kind = 'run') as runs,
       sum(kind = 'run' and status = 'failed') as runsFailed`;

function sendSlots(db: Db, bounds: Bounds): SendSlot[] {
  return db
    .query<SendSlot, Bounds>(
      `select started_at / ${SLOT_MS} as slot, ${SEND_SUMS}
         from sends where started_at >= ? and started_at < ?
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

// every send and every round there is; sums of no rows are null
function allTime(db: Db): AllTime {
  const sends = db
    .query<Omit<SendSlot, "slot"> & { since: number | null }, []>(
      `select ${SEND_SUMS}, min(started_at) as since from sends`,
    )
    .get()!;
  const usage = db
    .query<Omit<UsageSlot, "slot">, []>(`select ${USAGE_SUMS} from usage`)
    .get()!;
  return {
    turns: sends.turns ?? 0,
    turnsFailed: sends.turnsFailed ?? 0,
    runs: sends.runs ?? 0,
    runsFailed: sends.runsFailed ?? 0,
    since: sends.since,
    prompt: usage.prompt ?? 0,
    cached: usage.cached ?? 0,
    completion: usage.completion ?? 0,
    rounds: usage.rounds,
    priced: usage.priced,
    cost: usage.priced > 0 ? usage.cost : null,
  };
}

type Tokens = { key: string; tokens: number };
type Sends = { key: string; turns: number; runs: number };
type Named = Pick<GroupRow, "key" | "id" | "name" | "owner">;

// the tokens of a group from usage alone and its sends from sends
// alone, joined by key: a send with three rounds counts once
function grouped(
  db: Db,
  bounds: Bounds,
  tokensSql: string,
  sendsSql: string,
  names: Named[],
): GroupRow[] {
  const tokens = new Map(
    db
      .query<Tokens, Bounds>(tokensSql)
      .all(...bounds)
      .map((row) => [row.key, row]),
  );
  const sends = new Map(
    db
      .query<Sends, Bounds>(sendsSql)
      .all(...bounds)
      .map((row) => [row.key, row]),
  );
  const rows: GroupRow[] = [];
  for (const named of names) {
    const t = tokens.get(named.key);
    const s = sends.get(named.key);
    if (t === undefined && s === undefined) continue;
    rows.push({
      ...named,
      tokens: t?.tokens ?? 0,
      turns: s?.turns ?? 0,
      runs: s?.runs ?? 0,
    });
  }
  return rows;
}

const USAGE_BY = (key: string) =>
  `select ${key} as key, sum(prompt_tokens + completion_tokens) as tokens
     from usage where created_at >= ? and created_at < ? group by key`;

function byAgents(db: Db, bounds: Bounds): GroupRow[] {
  const names = db
    .query<{ id: string; name: string }, []>("select id, name from agents")
    .all()
    .map((row) => ({
      key: row.id,
      id: row.id,
      name: row.name,
      owner: null,
    }));
  return grouped(
    db,
    bounds,
    USAGE_BY("agent_id"),
    `select agent_id as key, sum(kind != 'run') as turns,
            sum(kind = 'run') as runs
       from sends where started_at >= ? and started_at < ? group by key`,
    names,
  );
}

type ProjectRow = {
  id: string;
  kind: "personal" | "team";
  name: string;
  owner: string;
};

const projectNames = (db: Db): ProjectRow[] =>
  db
    .query<ProjectRow, []>(
      `select p.id, p.kind, p.name, u.username as owner
         from projects p join users u on u.id = p.owner_id`,
    )
    .all();

function byProjects(db: Db, bounds: Bounds): GroupRow[] {
  // a personal project is counted and never named
  const names = projectNames(db).map((project) =>
    project.kind === "personal"
      ? { key: project.id, id: null, name: null, owner: project.owner }
      : { key: project.id, id: project.id, name: project.name, owner: null },
  );
  return grouped(
    db,
    bounds,
    USAGE_BY("project_id"),
    `select x.project_id as key, sum(s.kind != 'run') as turns,
            sum(s.kind = 'run') as runs
       from sends s join sessions x on x.id = s.session_id
       where s.started_at >= ? and s.started_at < ? group by key`,
    names,
  );
}

// the chat turns of each model; a run's length is its task's, not the
// model's
function models(db: Db, bounds: Bounds): ModelRow[] {
  const rows = db
    .query<{ provider: string; model: string; turns: number }, Bounds>(
      `select p.name as provider, s.model, count(*) as turns
         from sends s join providers p on p.id = s.provider_id
         where s.kind != 'run' and s.started_at >= ? and s.started_at < ?
         group by s.provider_id, s.model order by turns desc, provider, model`,
    )
    .all(...bounds)
    .map((row): ModelRow => ({ ...row, lengths: [] }));
  const byKey = new Map(
    rows.map((row) => [`${row.provider}\n${row.model}`, row]),
  );
  for (const ended of db
    .query<{ provider: string; model: string; ms: number }, Bounds>(
      `select p.name as provider, s.model,
              max(s.finished_at - s.started_at, 0) as ms
         from sends s join providers p on p.id = s.provider_id
         where s.kind != 'run' and s.started_at >= ? and s.started_at < ?
           and s.status != 'running' and s.finished_at is not null`,
    )
    .all(...bounds)) {
    byKey.get(`${ended.provider}\n${ended.model}`)?.lengths.push(ended.ms);
  }
  return rows;
}

const count = (db: Db, sql: string): number =>
  db.query<{ n: number }, []>(sql).get()!.n;

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

function instance(db: Db): RangeResult["instance"] {
  const memory = db.filename === "" || db.filename === ":memory:";
  return {
    users: count(db, "select count(*) as n from users"),
    projects: count(
      db,
      "select count(*) as n from projects where kind = 'team'",
    ),
    agents: count(db, "select count(*) as n from agents"),
    automations: count(db, "select count(*) as n from automations"),
    databaseBytes: memory
      ? 0
      : sizeOf(db.filename) + sizeOf(`${db.filename}-wal`),
  };
}

// one read transaction, so every statement sees the same WAL snapshot
export function range(db: Db, input: RangeInput): RangeResult {
  db.exec("begin");
  try {
    return read(db, input);
  } finally {
    db.exec("rollback");
  }
}

function read(db: Db, input: RangeInput): RangeResult {
  const days: Bounds = [input.since, input.until];
  return {
    readAt: input.now,
    sends: sendSlots(db, days),
    usage: usageSlots(db, days),
    by: { projects: byProjects(db, days), agents: byAgents(db, days) },
    models: models(db, days),
    all: allTime(db),
    instance: instance(db),
  };
}
