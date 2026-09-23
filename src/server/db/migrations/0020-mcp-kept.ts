// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// MCP results too large for the context, and embedded resources, kept
// with their tool row and read through /mcp; the session counts its
// folders so a number is never given twice
export const m0020: Migration = {
  id: "0020-mcp-kept",
  up(db) {
    db.exec(`
      create table mcp_kept_files (
        message_id text not null references messages(id) on delete cascade,
        position integer not null check (position >= 0),
        session_id text not null references sessions(id) on delete cascade,
        folder integer not null check (folder >= 1),
        dir text not null,
        name text not null,
        bytes integer not null check (bytes >= 0),
        text text,
        data blob,
        primary key (message_id, position),
        check ((text is null) <> (data is null))
      );
      create index mcp_kept_files_session on mcp_kept_files (session_id, folder);
      alter table sessions add column mcp_folders integer not null default 0;
    `);
  },
};
