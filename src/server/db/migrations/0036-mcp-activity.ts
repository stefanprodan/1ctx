// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// read by the MCP usage routes' toolRows, by wire name prefix
export const m0036: Migration = {
  id: "0036-mcp-activity",
  up(db) {
    db.exec(`
      create index messages_tool_activity
        on messages(tool_name, created_at, status)
        where kind = 'tool';
    `);
  },
};
