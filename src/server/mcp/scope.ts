// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A server's scope rows: the column says all or a list, the links hold
// the list's team projects.

import type { McpProjects } from "../../shared/api/mcp.ts";
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
