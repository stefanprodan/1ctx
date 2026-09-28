// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send has many usage rows, so sends and tokens are summed apart and
// joined by key.

import type { DeciderUsage, ModelUsage } from "../../shared/api/admin.ts";
import type { Db } from "../db/index.ts";

export type Bounds = [number, number];

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

type Tokens = { key: string; tokens: number; priced: number; cost: number };
type Sends = { key: string; turns: number; runs: number };
type Named = Pick<GroupRow, "key" | "id" | "name" | "owner" | "deleted">;

// a send with three rounds counts once; a deleted one without tokens is
// left out
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
  return rows.filter((row) => !row.deleted || row.tokens > 0);
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

// safe as a sentinel: no project id is empty
const DELETED_PROJECTS = "";

export function byProjects(db: Db, bounds: Bounds): GroupRow[] {
  // a personal project is never named
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

export function byModels(db: Db, bounds: Bounds): ModelUsage[] {
  return db
    .query<
      ModelUsage & { priced: number; cost: number },
      [number, number, number, number]
    >(
      `select p.name as provider, x.model, sum(x.tokens) as tokens,
              count(*) as rounds, count(x.cost) as priced,
              coalesce(sum(x.cost), 0) as cost
         from (select provider_id, coalesce(served_model, model) as model,
                      prompt_tokens + completion_tokens as tokens, cost
                 from usage where created_at >= ? and created_at < ?
               union all
               select provider_id, model,
                      coalesce(input_tokens, 0) + coalesce(output_tokens, 0),
                      cost
                 from decision_usage where created_at >= ? and created_at < ?
              ) x left join providers p on p.id = x.provider_id
         group by x.provider_id, x.model`,
    )
    .all(...bounds, ...bounds)
    .filter((row) => row.provider !== null || row.tokens > 0)
    .map(({ priced, cost, ...row }) => ({
      ...row,
      cost: priced > 0 ? cost : null,
    }));
}

// grouped by id, named by the latest: a decider keeps its rows after a
// rename or a delete
export function byDeciders(db: Db, bounds: Bounds): DeciderUsage[] {
  return db
    .query<DeciderUsage & { priced: number; last: number }, Bounds>(
      `select decider_name as name, max(created_at) as last,
              count(*) as decisions,
              coalesce(sum(input_tokens), 0)
                + coalesce(sum(output_tokens), 0) as tokens,
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
