// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { MessageUpload } from "../../shared/uploads.ts";
import type { Db } from "../db/index.ts";
import type { ExportRow } from "./markdown.ts";
import { listOrNull } from "./rows.ts";

export function exportRows(db: Db, sessionId: string): ExportRow[] {
  return db
    .query<Omit<ExportRow, "uploads"> & { uploads: string | null }, [string]>(
      `select messages.send_id as sendId, messages.round,
         sends.memory_round as memoryRound, messages.kind, messages.slot,
         messages.status, messages.error, messages.uploads,
         messages.finish_reason as finishReason,
         messages.native_finish as nativeFinish,
         coalesce(users.username, agents.name) as author,
         case when messages.kind = 'user'
             or (messages.kind = 'reply' and messages.slot = 'answer')
           then messages.content else '' end as content,
         messages.created_at as createdAt,
         messages.finished_at as finishedAt
       from messages
       join sends on sends.id = messages.send_id
       left join users on users.id = messages.user_id
       left join agents on agents.id = messages.agent_id
       where messages.session_id = ?
       order by messages.seq`,
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      uploads:
        row.kind === "user" ? listOrNull<MessageUpload>(row.uploads) : null,
    }));
}
