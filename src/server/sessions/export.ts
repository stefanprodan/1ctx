// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { MessageUpload } from "../../shared/uploads.ts";
import type { Db } from "../db/index.ts";
import { messageImagesSql } from "../images/index.ts";
import type { ExportRow } from "./markdown.ts";
import { imagesOf, listOrNull } from "./rows.ts";

// the rows whose text a transcript shows, over messages joined to their
// send: user messages and each send's answer before its memory phase.
// Session search reads the same rows, so every hit is a message a
// transcript can be read from
export const SHOWN = `(messages.kind = 'user'
  or (messages.kind = 'reply' and messages.slot = 'answer'
    and (sends.memory_round is null
      or messages.round < sends.memory_round)))`;

export function exportRows(db: Db, sessionId: string): ExportRow[] {
  return db
    .query<
      Omit<ExportRow, "uploads" | "images"> & {
        uploads: string | null;
        images: string | null;
      },
      [string]
    >(
      `select messages.id, messages.send_id as sendId, messages.round,
         sends.memory_round as memoryRound, messages.kind, messages.slot,
         messages.status, messages.error, messages.uploads,
         case when messages.kind = 'user'
           then ${messageImagesSql("messages")} end as images,
         messages.finish_reason as finishReason,
         messages.native_finish as nativeFinish,
         coalesce(users.username, agents.name) as author,
         case when ${SHOWN} then messages.content else '' end as content,
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
    .map(({ images, ...row }) => ({
      ...row,
      uploads:
        row.kind === "user" ? listOrNull<MessageUpload>(row.uploads) : null,
      ...imagesOf(images),
    }));
}
