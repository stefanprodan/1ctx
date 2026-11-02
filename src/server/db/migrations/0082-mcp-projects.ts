// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Where an MCP server is offered: every project, or the team projects
// linked to it. Every server held stays offered everywhere; a link goes
// with its server and with its project. Added column and table only.
export const m0082: Migration = {
  id: "0082-mcp-projects",
  up(db) {
    db.exec(`
      alter table mcp_servers add column scope text not null default 'all'
        check (scope in ('all', 'projects'));

      create table mcp_server_projects (
        server_id text not null references mcp_servers(id) on delete cascade,
        project_id text not null references projects(id) on delete cascade,
        primary key (server_id, project_id)
      );
      create index mcp_server_projects_project
        on mcp_server_projects(project_id);
    `);
  },
};
