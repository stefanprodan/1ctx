// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An MCP server's page counts its calls over the last 30 days by the
// tool rows' wire names, which start with the server's, from an index
// that holds only tool rows.
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
