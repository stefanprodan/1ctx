// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A project chooses each MCP server it is granted, an agent keeps one
// switch, and the per-agent links go. Absent from project_mcp is read,
// so rows are written only where the links gave another side: write
// where an agent linked the server with write, off on a list nobody
// linked. An all server nobody linked becomes an empty list, offered
// nowhere as before. Added columns and a table, then the drop.
export const m0083: Migration = {
  id: "0083-mcp-access",
  up(db) {
    db.exec(`
      alter table agents add column mcp_on integer not null default 1
        check (mcp_on in (0, 1));
      update agents set mcp_on = 0
        where not exists (select 1 from agent_servers l where l.agent_id = agents.id);

      alter table mcp_servers add column personal text not null default 'off'
        check (personal in ('off', 'read', 'write'));

      create table project_mcp (
        project_id text not null references projects(id) on delete cascade,
        server_id text not null references mcp_servers(id) on delete cascade,
        side text not null check (side in ('off', 'read', 'write')),
        primary key (project_id, server_id)
      );
      create index project_mcp_server on project_mcp(server_id);

      update mcp_servers set personal = case
          when exists (select 1 from agent_servers l
                       where l.server_id = mcp_servers.id and l.write = 1)
            then 'write'
          when exists (select 1 from agent_servers l
                       where l.server_id = mcp_servers.id)
            then 'read'
          else 'off' end
        where scope = 'all';

      insert into project_mcp (project_id, server_id, side)
        select p.id, s.id, 'write' from mcp_servers s, projects p
        where exists (select 1 from agent_servers l
                      where l.server_id = s.id and l.write = 1)
          and (s.scope = 'all' or exists (
            select 1 from mcp_server_projects g
            where g.server_id = s.id and g.project_id = p.id));

      insert into project_mcp (project_id, server_id, side)
        select g.project_id, g.server_id, 'off' from mcp_server_projects g
        where not exists (select 1 from agent_servers l
                          where l.server_id = g.server_id);

      update mcp_servers set scope = 'projects'
        where scope = 'all' and not exists (
          select 1 from agent_servers l where l.server_id = mcp_servers.id);

      drop index agent_servers_server;
      drop table agent_servers;
    `);
  },
};
