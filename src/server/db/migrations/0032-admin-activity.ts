// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The admin pages' reads by agent, provider, tool and day.
// sends_started and usage_created keep the Stats and Usage reads in the
// overview worker to the window instead of the whole history.
export const m0032: Migration = {
  id: "0032-admin-activity",
  up(db) {
    db.exec(`
      create index sends_agent on sends(agent_id, started_at);
      create index sends_running on sends(agent_id) where status = 'running';
      create index sends_started on sends(started_at);
      create index usage_provider_activity on usage(provider_id, created_at);
      create index usage_created on usage(created_at);
      create index messages_tool_activity
        on messages(tool_name, created_at, status) where kind = 'tool';
      create index visits_day on visits(day, user_id);
    `);
  },
};
