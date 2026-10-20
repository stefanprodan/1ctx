// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SessionStatus } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { type RawSession, type SessionRow, session } from "./rows.ts";

export function touchSession(
  db: Db,
  id: string,
  status: SessionStatus,
  now: number,
): void {
  db.query(`update sessions set status = case
    when origin = 'channel' and parent_session_id is null then
      case when exists (
        select 1 from sends where session_id = sessions.id and status = 'running'
      ) then 'running' else 'done' end
    else ? end, last_activity_at = ?, revision = revision + 1 where id = ?`).run(
    status,
    now,
    id,
  );
}

export function createChannel(
  db: Db,
  fields: { projectId: string; title: string; now: number },
): string {
  const id = newId();
  db.query(
    `insert into sessions
      (id, project_id, owner_id, agent_id, origin, title, status,
       revision, created_at, last_activity_at)
     values (?, ?, null, null, 'channel', ?, 'done', 0, ?, ?)`,
  ).run(id, fields.projectId, fields.title, fields.now, fields.now);
  return id;
}

export function renameChannel(
  db: Db,
  projectId: string,
  title: string,
): SessionRow | null {
  db.query(
    `update sessions set title = ?, revision = revision + 1
     where project_id = ? and origin = 'channel'
       and parent_session_id is null`,
  ).run(title, projectId);
  const raw = db
    .query<RawSession, [string]>(
      `select * from sessions where project_id = ? and origin = 'channel'
         and parent_session_id is null`,
    )
    .get(projectId);
  return raw ? session(raw, null) : null;
}
