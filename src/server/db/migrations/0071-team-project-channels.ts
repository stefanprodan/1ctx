// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { newId } from "../../lib/ids.ts";
import type { Migration } from "../migration.ts";

// The rebuild keeps its row count invariant; channels are added only
// after every referenced table and index has its final shape.
export const m0071: Migration = {
  id: "0071-team-project-channels",
  up(db) {
    const projects = db
      .query<{ id: string; name: string; created_at: number }, []>(
        "select id, name, created_at from projects where kind = 'team' order by id",
      )
      .all();
    const insert = db.query(
      `insert into sessions
        (id, project_id, owner_id, agent_id, origin, title, status,
         revision, created_at, last_activity_at)
       values (?, ?, null, null, 'channel', ?, 'done', 0, ?, ?)`,
    );
    for (const project of projects) {
      insert.run(
        newId(),
        project.id,
        project.name,
        project.created_at,
        project.created_at,
      );
    }
  },
};
