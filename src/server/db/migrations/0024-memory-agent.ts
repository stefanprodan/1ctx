// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a note keeps the name of the agent that saved it last, so the note
// still says who wrote it once the chat or run is deleted; the notes a
// session saved take its agent's name
export const m0024: Migration = {
  id: "0024-memory-agent",
  up(db) {
    db.exec(`
      alter table memory_notes add column agent_name text;
      update memory_notes set agent_name = (
        select agents.name from sessions
        join agents on agents.id = sessions.agent_id
        where sessions.id = memory_notes.session_id
      ) where session_id is not null;
    `);
  },
};
