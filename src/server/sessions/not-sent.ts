// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's list of a user's messages that were not sent. A summon names
// the agent it called, retired or not, since that agent would have
// answered it.

import type { NotSentRow } from "../../shared/api/sessions.ts";
import { summonName } from "../../shared/summon.ts";
import type { NotSentReason } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { lineFrom } from "./parse.ts";

type RawNotSent = {
  id: string;
  session_id: string;
  title: string;
  project: string;
  agent: string;
  content: string;
  reason: NotSentReason;
  changed_at: number;
};

export function notSentOf(
  db: Db,
  userId: string,
  projectIds: readonly string[],
): NotSentRow[] {
  const raws = db
    .query<RawNotSent, [string, string]>(
      `select q.id, q.session_id, s.title, p.name as project,
         a.name as agent, q.content, q.reason, q.changed_at
       from queued_messages q
       join sessions s on s.id = q.session_id
       join projects p on p.id = s.project_id
       join agents a on a.id = s.agent_id
       where q.author_id = ? and q.state = 'not-sent'
         and s.project_id in (select value from json_each(?))
       order by q.changed_at desc, q.id`,
    )
    .all(userId, JSON.stringify(projectIds));
  const words = raws.map((raw) => summonName(raw.content) ?? undefined);
  const asked = [...new Set(words.filter((word) => word !== undefined))];
  const named = new Set(
    asked.length === 0
      ? []
      : db
          .query<{ name: string }, [string]>(
            "select name from agents where name in (select value from json_each(?))",
          )
          .all(JSON.stringify(asked))
          .map((row) => row.name),
  );
  return raws.map((raw, index) => {
    const word = words[index];
    return {
      id: raw.id,
      sessionId: raw.session_id,
      title: raw.title,
      project: raw.project,
      agent: word !== undefined && named.has(word) ? word : raw.agent,
      line: lineFrom(raw.content),
      reason: raw.reason,
      changedAt: raw.changed_at,
    };
  });
}
