// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The usage page's breakdowns over one range: by project, agent and
// model from the rounds, the chat turns' lengths by the model that
// answered, and the deciders by their decisions. A send has many
// usage rows, so sends and tokens are summed from their own table each
// and joined by key afterwards, never in one query.

import type { DeciderUsage, ModelUsage } from "../../shared/api/admin.ts";
import type { Db } from "../db/index.ts";

export type Bounds = [number, number];

// one row of a breakdown before its top is taken: the key that groups
// it, the names the answer draws, and its sums
export type GroupRow = {
  key: string;
  id: string | null;
  name: string | null;
  owner: string | null;
  deleted: boolean;
  tokens: number;
  cost: number | null;
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

type Tokens = { key: string; tokens: number; priced: number; cost: number };
type Sends = { key: string; turns: number; runs: number };
type Named = Pick<GroupRow, "key" | "id" | "name" | "owner" | "deleted">;

// the tokens of a group from usage alone and its sends from sends
// alone, joined by key: a send with three rounds counts once. Usage
// outlives its project, so a key no row names is a deleted one, kept
// by its id, or summed into one row keyed merged when it is given
function grouped(
  db: Db,
  bounds: Bounds,
  tokensSql: string,
  sendsSql: string,
  names: Named[],
  merged?: string,
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
      cost: t && t.priced > 0 ? t.cost : null,
      turns: s?.turns ?? 0,
      runs: s?.runs ?? 0,
    });
  }
  const named = new Set(names.map((row) => row.key));
  let gone: GroupRow | undefined;
  for (const [key, t] of tokens) {
    if (named.has(key)) continue;
    const s = sends.get(key);
    const row: GroupRow = {
      key: merged ?? key,
      id: merged === undefined ? key : null,
      name: null,
      owner: null,
      deleted: true,
      tokens: t.tokens,
      cost: t.priced > 0 ? t.cost : null,
      turns: s?.turns ?? 0,
      runs: s?.runs ?? 0,
    };
    if (merged === undefined) {
      rows.push(row);
    } else if (gone === undefined) {
      gone = row;
      rows.push(gone);
    } else {
      gone.tokens += row.tokens;
      if (row.cost !== null) gone.cost = (gone.cost ?? 0) + row.cost;
      gone.turns += row.turns;
      gone.runs += row.runs;
    }
  }
  return rows;
}

const USAGE_BY = (key: string) =>
  `select ${key} as key, sum(prompt_tokens + completion_tokens) as tokens,
          count(cost) as priced, coalesce(sum(cost), 0) as cost
     from usage where created_at >= ? and created_at < ? group by key`;

export function byAgents(db: Db, bounds: Bounds): GroupRow[] {
  const names = db
    .query<{ id: string; name: string; retired: number }, []>(
      "select id, name, deleted_at is not null as retired from agents",
    )
    .all()
    .map((row) => ({
      key: row.id,
      id: row.id,
      name: row.name,
      owner: null,
      deleted: row.retired === 1,
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

// every deleted project is one row: none has a name left to tell them
// apart. No project id is empty
const DELETED_PROJECTS = "";

export function byProjects(db: Db, bounds: Bounds): GroupRow[] {
  // a personal project is counted and never named
  const names = projectNames(db).map((project) =>
    project.kind === "personal"
      ? {
          key: project.id,
          id: null,
          name: null,
          owner: project.owner,
          deleted: false,
        }
      : {
          key: project.id,
          id: project.id,
          name: project.name,
          owner: null,
          deleted: false,
        },
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
    DELETED_PROJECTS,
  );
}

// the model that answered a send: its answer round's, when a router
// served another than the one asked for. Only that round counts: an
// earlier round's pick says nothing about a last round without usage,
// and the memory phase, when it ran, is the round after the answer
const ANSWERED = `coalesce((select u.served_model from usage u
     where u.send_id = s.id
       and u.round = coalesce(s.memory_round - 1, s.rounds)), s.model)`;

// the chat turns of each model; a run's length is its task's, not the
// model's
export function models(db: Db, bounds: Bounds): ModelRow[] {
  const rows = db
    .query<{ provider: string; answered: string; turns: number }, Bounds>(
      `select s.provider_name as provider, ${ANSWERED} as answered,
              count(*) as turns
         from sends s
         where s.kind != 'run' and s.started_at >= ? and s.started_at < ?
         group by s.provider_name, answered
         order by turns desc, provider, answered`,
    )
    .all(...bounds)
    .map(
      (row): ModelRow => ({
        provider: row.provider,
        model: row.answered,
        turns: row.turns,
        lengths: [],
      }),
    );
  const byKey = new Map(
    rows.map((row) => [`${row.provider}\n${row.model}`, row]),
  );
  for (const ended of db
    .query<{ provider: string; model: string; ms: number }, Bounds>(
      `select s.provider_name as provider, ${ANSWERED} as model,
              max(s.finished_at - s.started_at, 0) as ms
         from sends s
         where s.kind != 'run' and s.started_at >= ? and s.started_at < ?
           and s.status != 'running' and s.finished_at is not null`,
    )
    .all(...bounds)) {
    byKey.get(`${ended.provider}\n${ended.model}`)?.lengths.push(ended.ms);
  }
  return rows;
}

// the rounds by the provider and the model that answered them; a
// deleted provider's rounds keep its model with no provider name
export function byModels(db: Db, bounds: Bounds): ModelUsage[] {
  return db
    .query<ModelUsage & { priced: number; cost: number }, Bounds>(
      `select p.name as provider,
              coalesce(u.served_model, u.model) as model,
              sum(u.prompt_tokens + u.completion_tokens) as tokens,
              count(*) as rounds, count(u.cost) as priced,
              coalesce(sum(u.cost), 0) as cost
         from usage u left join providers p on p.id = u.provider_id
         where u.created_at >= ? and u.created_at < ?
         group by u.provider_id, coalesce(u.served_model, u.model)`,
    )
    .all(...bounds)
    .map(({ priced, cost, ...row }) => ({
      ...row,
      cost: priced > 0 ? cost : null,
    }));
}

// the decisions by decider under the name of its latest one, since a
// decider keeps its rows after a rename or a delete
export function byDeciders(db: Db, bounds: Bounds): DeciderUsage[] {
  return db
    .query<DeciderUsage & { priced: number; last: number }, Bounds>(
      `select decider_name as name, max(created_at) as last,
              count(*) as decisions,
              coalesce(sum(input_tokens), 0) as tokens,
              count(cost) as priced, sum(cost) as cost
         from decision_usage where created_at >= ? and created_at < ?
         group by decider_id`,
    )
    .all(...bounds)
    .map(({ priced, last: _last, ...row }) => ({
      ...row,
      cost: priced > 0 ? row.cost : null,
    }));
}
