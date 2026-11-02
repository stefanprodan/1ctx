// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A server's grant rows: the column says all or a list, the links hold
// the list's team projects; and each project's choices.

import type { McpProjects } from "../../shared/api/mcp.ts";
import type { McpSide } from "../../shared/contracts/mcp.ts";
import { type Granted, offeredSide, SIDE_RANK } from "../../shared/mcp.ts";
import type { ProjectKind } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";

export function projectIdsOf(db: Db, serverId: string): string[] {
  return db
    .query<{ project_id: string }, [string]>(
      `select project_id from mcp_server_projects where server_id = ?
       order by project_id`,
    )
    .all(serverId)
    .map((link) => link.project_id);
}

// every server's projects in one query
export function allProjectIds(db: Db): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const links = db
    .query<{ server_id: string; project_id: string }, []>(
      "select server_id, project_id from mcp_server_projects order by project_id",
    )
    .all();
  for (const link of links) {
    const list = out.get(link.server_id) ?? [];
    list.push(link.project_id);
    out.set(link.server_id, list);
  }
  return out;
}

// the whole scope, replacing what was held; ids are checked team
// projects
export function writeScope(db: Db, id: string, projects: McpProjects): void {
  db.query("update mcp_servers set scope = ? where id = ?").run(
    projects === "all" ? "all" : "projects",
    id,
  );
  db.query("delete from mcp_server_projects where server_id = ?").run(id);
  if (projects === "all") return;
  const insert = db.query(
    "insert into mcp_server_projects (server_id, project_id) values (?, ?)",
  );
  for (const projectId of new Set(projects)) insert.run(id, projectId);
}

export function addLink(db: Db, id: string, projectId: string): boolean {
  return (
    db
      .query(
        `insert or ignore into mcp_server_projects (server_id, project_id)
         values (?, ?)`,
      )
      .run(id, projectId).changes > 0
  );
}

export function removeLink(db: Db, id: string, projectId: string): boolean {
  return (
    db
      .query(
        "delete from mcp_server_projects where server_id = ? and project_id = ?",
      )
      .run(id, projectId).changes > 0
  );
}

// a project's kind and what it chose, by server id; absent is read
export type ProjectChoices = {
  kind: ProjectKind;
  sides: Map<string, McpSide>;
};

// one indexed read per send: the project's row and its choices
export function choicesOf(db: Db, projectId: string): ProjectChoices | null {
  const rows = db
    .query<
      { kind: ProjectKind; server_id: string | null; side: McpSide | null },
      [string]
    >(
      `select p.kind, c.server_id, c.side from projects p
       left join project_mcp c on c.project_id = p.id
       where p.id = ?`,
    )
    .all(projectId);
  if (rows.length === 0) return null;
  const sides = new Map<string, McpSide>();
  for (const row of rows) {
    if (row.server_id !== null && row.side !== null) {
      sides.set(row.server_id, row.side);
    }
  }
  return { kind: rows[0]!.kind, sides };
}

export function writeChoice(
  db: Db,
  projectId: string,
  serverId: string,
  side: McpSide,
): void {
  if (side === "read") {
    db.query(
      "delete from project_mcp where project_id = ? and server_id = ?",
    ).run(projectId, serverId);
    return;
  }
  db.query(
    `insert into project_mcp (project_id, server_id, side) values (?, ?, ?)
     on conflict (project_id, server_id) do update set side = excluded.side`,
  ).run(projectId, serverId, side);
}

// the projects among ids with their kind and choices, in one query
export function choicesIn(
  db: Db,
  projectIds: readonly string[],
): Map<string, ProjectChoices> {
  const out = new Map<string, ProjectChoices>();
  const rows = db
    .query<
      {
        id: string;
        kind: ProjectKind;
        server_id: string | null;
        side: McpSide | null;
      },
      [string]
    >(
      `select p.id, p.kind, c.server_id, c.side from projects p
       left join project_mcp c on c.project_id = p.id
       where p.id in (select value from json_each(?))`,
    )
    .all(JSON.stringify(projectIds));
  for (const row of rows) {
    const held = out.get(row.id) ?? { kind: row.kind, sides: new Map() };
    if (row.server_id !== null && row.side !== null) {
      held.sides.set(row.server_id, row.side);
    }
    out.set(row.id, held);
  }
  return out;
}

// where each server is on: every team project by id with the side it
// gives, and how many personal projects, read from every team row and
// the personal choices counted by side
export function whereOn(
  db: Db,
  servers: readonly (Granted & { id: string })[],
): Map<
  string,
  { teams: Map<string, McpSide>; personal: number; widest: McpSide }
> {
  const teams = db
    .query<{ id: string }, []>("select id from projects where kind = 'team'")
    .all()
    .map((row) => row.id);
  const personalCount = db
    .query<{ n: number }, []>(
      "select count(*) as n from projects where kind = 'personal'",
    )
    .get()!.n;
  const teamChoices = new Map<string, Map<string, McpSide>>();
  const personalChoices = new Map<string, Map<McpSide, number>>();
  const rows = db
    .query<
      {
        project_id: string;
        server_id: string;
        side: McpSide;
        kind: ProjectKind;
      },
      []
    >(
      `select c.project_id, c.server_id, c.side, p.kind from project_mcp c
       join projects p on p.id = c.project_id`,
    )
    .all();
  for (const row of rows) {
    if (row.kind === "team") {
      const held = teamChoices.get(row.server_id) ?? new Map();
      held.set(row.project_id, row.side);
      teamChoices.set(row.server_id, held);
    } else {
      const held = personalChoices.get(row.server_id) ?? new Map();
      held.set(row.side, (held.get(row.side) ?? 0) + 1);
      personalChoices.set(row.server_id, held);
    }
  }
  const out = new Map<
    string,
    { teams: Map<string, McpSide>; personal: number; widest: McpSide }
  >();
  for (const server of servers) {
    let widest: McpSide = "off";
    const widen = (side: McpSide) => {
      if (SIDE_RANK[side] > SIDE_RANK[widest]) widest = side;
    };
    const on = new Map<string, McpSide>();
    const chosen = teamChoices.get(server.id);
    for (const id of teams) {
      const side = offeredSide(server, { id, kind: "team" }, chosen?.get(id));
      if (side !== "off") on.set(id, side);
      widen(side);
    }
    const counts = personalChoices.get(server.id) ?? new Map<McpSide, number>();
    let unchosen = personalCount;
    let personal = 0;
    const own = { id: "", kind: "personal" as const };
    for (const [choice, n] of counts) {
      unchosen -= n;
      const side = offeredSide(server, own, choice);
      if (side !== "off") personal += n;
      if (n > 0) widen(side);
    }
    const side = offeredSide(server, own, null);
    if (side !== "off") personal += unchosen;
    if (unchosen > 0) widen(side);
    out.set(server.id, { teams: on, personal, widest });
  }
  return out;
}
