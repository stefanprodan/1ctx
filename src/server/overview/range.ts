// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The overview's range: every query the answer needs over one
// connection, read once in one transaction and shaped into plain data
// the worker can post. The days come as sums by quarter hour of UTC,
// which every zone's midnight falls on, laid on the zone's days by the
// caller; the breakdowns and the models take the range's bounds. A
// send has many usage rows, so sends and tokens are summed from their
// own table each and joined by key afterwards, never in one query.

import { statSync } from "node:fs";
import type { Db } from "../db/index.ts";

export type RangeInput = {
  now: number;
  // the slots cover [since, until), the range before it included
  since: number;
  until: number;
  // the breakdowns and the models cover [rangeSince, until)
  rangeSince: number;
};

export type SendSlot = { slot: number; sends: number; failed: number };

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
  sub: string | null;
  tokens: number;
  sends: number;
  failed: number;
  cost: number | null;
};

export type ModelRow = {
  provider: string;
  model: string;
  sends: number;
  failed: number;
  // the lengths and the rounds of the ended sends
  lengths: number[];
  rounds: number[];
};

export type RangeResult = {
  readAt: number;
  sends: SendSlot[];
  usage: UsageSlot[];
  by: {
    users: GroupRow[];
    agents: GroupRow[];
    models: GroupRow[];
    projects: GroupRow[];
    tasks: GroupRow[];
  };
  models: ModelRow[];
  instance: {
    users: number;
    projects: number;
    agents: number;
    tasks: number;
    servers: number;
    databaseBytes: number;
  };
};

export const SLOT_MS = 900_000;

type Bounds = [number, number];

function sendSlots(db: Db, bounds: Bounds): SendSlot[] {
  return db
    .query<SendSlot, Bounds>(
      `select started_at / ${SLOT_MS} as slot, count(*) as sends,
              sum(status = 'failed') as failed
         from sends where started_at >= ? and started_at < ?
         group by slot order by slot`,
    )
    .all(...bounds);
}

function usageSlots(db: Db, bounds: Bounds): UsageSlot[] {
  return db
    .query<UsageSlot, Bounds>(
      `select created_at / ${SLOT_MS} as slot,
              sum(prompt_tokens) as prompt,
              sum(coalesce(cached_tokens, 0)) as cached,
              sum(completion_tokens) as completion,
              count(*) as rounds, count(cost) as priced, sum(cost) as cost
         from usage where created_at >= ? and created_at < ?
         group by slot order by slot`,
    )
    .all(...bounds);
}

type Tokens = { key: string; tokens: number; priced: number; cost: number };
type Sends = { key: string; sends: number; failed: number };
type Named = Pick<GroupRow, "key" | "id" | "name" | "owner" | "sub">;

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
      sends: s?.sends ?? 0,
      failed: s?.failed ?? 0,
      cost: t !== undefined && t.priced > 0 ? t.cost : null,
    });
  }
  return rows;
}

const USAGE_BY = (key: string) =>
  `select ${key} as key, sum(prompt_tokens + completion_tokens) as tokens,
          count(cost) as priced, coalesce(sum(cost), 0) as cost
     from usage where created_at >= ? and created_at < ? group by key`;

const SENDS_BY = (key: string) =>
  `select ${key} as key, count(*) as sends, sum(status = 'failed') as failed
     from sends where started_at >= ? and started_at < ? group by key`;

function byUsers(db: Db, bounds: Bounds): GroupRow[] {
  const names = db
    .query<{ id: string; username: string }, []>(
      "select id, username from users",
    )
    .all()
    .map((row) => ({
      key: row.id,
      id: row.id,
      name: row.username,
      owner: null,
      sub: null,
    }));
  return grouped(db, bounds, USAGE_BY("user_id"), SENDS_BY("user_id"), names);
}

function byAgents(db: Db, bounds: Bounds): GroupRow[] {
  const names = db
    .query<{ id: string; name: string }, []>("select id, name from agents")
    .all()
    .map((row) => ({
      key: row.id,
      id: row.id,
      name: row.name,
      owner: null,
      sub: null,
    }));
  return grouped(db, bounds, USAGE_BY("agent_id"), SENDS_BY("agent_id"), names);
}

// a model is keyed by its provider too, since two providers may list
// one id
function byModels(db: Db, bounds: Bounds): GroupRow[] {
  const providers = new Map(
    db
      .query<{ id: string; name: string }, []>("select id, name from providers")
      .all()
      .map((row) => [row.id, row.name]),
  );
  const keys = db
    .query<{ providerId: string; model: string }, [...Bounds, ...Bounds]>(
      `select provider_id as providerId, model from usage
         where created_at >= ? and created_at < ?
       union
       select provider_id as providerId, model from sends
         where started_at >= ? and started_at < ?`,
    )
    .all(...bounds, ...bounds);
  const names = keys.map((row) => ({
    key: `${row.providerId}\n${row.model}`,
    id: null,
    name: row.model,
    owner: null,
    sub: providers.get(row.providerId) ?? null,
  }));
  return grouped(
    db,
    bounds,
    USAGE_BY("provider_id || char(10) || model"),
    SENDS_BY("provider_id || char(10) || model"),
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

// a personal project is counted and never named
const naming = (
  project: ProjectRow,
  own: { id: string; name: string },
  sub: string | null,
): Pick<GroupRow, "id" | "name" | "owner" | "sub"> =>
  project.kind === "personal"
    ? { id: null, name: null, owner: project.owner, sub: null }
    : { id: own.id, name: own.name, owner: null, sub };

function byProjects(db: Db, bounds: Bounds): GroupRow[] {
  const names = projectNames(db).map((project) => ({
    key: project.id,
    ...naming(project, project, null),
  }));
  return grouped(
    db,
    bounds,
    USAGE_BY("project_id"),
    `select x.project_id as key, count(*) as sends,
            sum(s.status = 'failed') as failed
       from sends s join sessions x on x.id = s.session_id
       where s.started_at >= ? and s.started_at < ? group by key`,
    names,
  );
}

function byTasks(db: Db, bounds: Bounds): GroupRow[] {
  const projects = new Map(projectNames(db).map((row) => [row.id, row]));
  const names: Named[] = [];
  for (const task of db
    .query<{ id: string; projectId: string; name: string }, []>(
      "select id, project_id as projectId, name from automations",
    )
    .all()) {
    const project = projects.get(task.projectId);
    if (project === undefined) continue;
    names.push({ key: task.id, ...naming(project, task, project.name) });
  }
  return grouped(
    db,
    bounds,
    `select x.automation_id as key,
            sum(u.prompt_tokens + u.completion_tokens) as tokens,
            count(u.cost) as priced, coalesce(sum(u.cost), 0) as cost
       from usage u join sessions x on x.id = u.session_id
       where x.automation_id is not null
         and u.created_at >= ? and u.created_at < ? group by key`,
    `select x.automation_id as key, count(*) as sends,
            sum(s.status = 'failed') as failed
       from sends s join sessions x on x.id = s.session_id
       where x.automation_id is not null
         and s.started_at >= ? and s.started_at < ? group by key`,
    names,
  );
}

function models(db: Db, bounds: Bounds): ModelRow[] {
  const rows = db
    .query<
      { provider: string; model: string; sends: number; failed: number },
      Bounds
    >(
      `select p.name as provider, s.model, count(*) as sends,
              sum(s.status = 'failed') as failed
         from sends s join providers p on p.id = s.provider_id
         where s.started_at >= ? and s.started_at < ?
         group by s.provider_id, s.model order by sends desc, provider, model`,
    )
    .all(...bounds)
    .map((row) => ({ ...row, lengths: [], rounds: [] }) as ModelRow);
  const byKey = new Map(
    rows.map((row) => [`${row.provider}\n${row.model}`, row]),
  );
  for (const ended of db
    .query<
      { provider: string; model: string; ms: number; rounds: number },
      Bounds
    >(
      `select p.name as provider, s.model,
              s.finished_at - s.started_at as ms, s.rounds
         from sends s join providers p on p.id = s.provider_id
         where s.started_at >= ? and s.started_at < ?
           and s.status != 'running' and s.finished_at is not null`,
    )
    .all(...bounds)) {
    const row = byKey.get(`${ended.provider}\n${ended.model}`);
    if (row === undefined) continue;
    row.lengths.push(ended.ms);
    row.rounds.push(ended.rounds);
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
    tasks: count(db, "select count(*) as n from automations"),
    servers: count(db, "select count(*) as n from mcp_servers"),
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
  const all: Bounds = [input.since, input.until];
  const own: Bounds = [input.rangeSince, input.until];
  return {
    readAt: input.now,
    sends: sendSlots(db, all),
    usage: usageSlots(db, all),
    by: {
      users: byUsers(db, own),
      agents: byAgents(db, own),
      models: byModels(db, own),
      projects: byProjects(db, own),
      tasks: byTasks(db, own),
    },
    models: models(db, own),
    instance: instance(db),
  };
}
