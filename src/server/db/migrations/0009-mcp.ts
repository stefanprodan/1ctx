// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// MCP servers, their discovered tools, an agent's servers with the
// sides it may use, the content-addressed digests of what a send
// offered from MCP, and the agent's mode.

import type { Migration } from "../migration.ts";

export const m0009: Migration = {
  id: "0009-mcp",
  up(db) {
    db.exec(`
      create table mcp_servers (
        id text primary key,
        name text not null unique,
        url text not null,
        key_name text,
        read integer not null default 0 check (read in (0, 1)),
        write integer not null default 0 check (write in (0, 1)),
        instructions_on integer not null default 1
          check (instructions_on in (0, 1)),
        timeout_ms integer,
        read_patterns text not null,
        write_patterns text not null,
        excluded_patterns text not null,
        server_name text not null,
        server_version text not null,
        protocol_version text not null,
        instructions text not null,
        fingerprint text not null,
        checked_at integer not null,
        last_change text,
        refresh_error text,
        refresh_failed_at integer,
        created_at integer not null
      );

      create table mcp_tools (
        server_id text not null references mcp_servers(id) on delete cascade,
        name text not null,
        description text not null,
        input_schema text not null,
        unusable text,
        primary key (server_id, name)
      );

      create table agent_servers (
        agent_id text not null references agents(id) on delete cascade,
        server_id text not null references mcp_servers(id),
        read integer not null default 0 check (read in (0, 1)),
        write integer not null default 0 check (write in (0, 1)),
        primary key (agent_id, server_id),
        check (read = 1 or write = 1)
      );
      create index agent_servers_server on agent_servers(server_id);

      create table mcp_digests (
        key text primary key,
        body text not null
      );

      alter table sends add column mcp text;

      alter table agents add column mcp_mode text not null default 'auto'
        check (mcp_mode in ('all', 'catalog', 'auto'));
    `);
  },
};
