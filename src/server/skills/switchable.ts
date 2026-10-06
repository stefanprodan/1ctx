// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SwitchableSkill } from "../../shared/api/sessions.ts";
import type { Db } from "../db/index.ts";

export function switchable(db: Db): Record<string, SwitchableSkill[]> {
  const out: Record<string, SwitchableSkill[]> = {};
  const rows = db
    .query<{ agent_id: string; id: string; name: string }, []>(
      `select a.agent_id, s.id, s.name
         from agent_skills a join skills s on s.id = a.skill_id
        order by s.name`,
    )
    .all();
  for (const row of rows) {
    out[row.agent_id] ??= [];
    out[row.agent_id]!.push({ id: row.id, name: row.name });
  }
  return out;
}
