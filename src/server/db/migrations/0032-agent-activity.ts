// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// read by the agents list's agentActivity: last run and running now
export const m0032: Migration = {
  id: "0032-agent-activity",
  up(db) {
    db.exec(`
      create index sends_agent on sends(agent_id, started_at);
      create index sends_running on sends(agent_id) where status = 'running';
    `);
  },
};
