// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The row replacement inside Writer.startSend's transaction. The new
// send already exists, so the kept user row can move before its old
// send is deleted and every foreign key remains valid.

import type { Message } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import { MESSAGE_COLUMNS, message, type RawMessage } from "./rows.ts";

export function replaceSendRows(
  db: Db,
  user: Message,
  newSendId: string,
): { user: Message; removedMessageIds: string[] } {
  const removedMessageIds = db
    .query<{ id: string }, [string, number]>(
      "select id from messages where session_id = ? and seq > ? order by seq",
    )
    .all(user.sessionId, user.seq)
    .map((row) => row.id);
  db.query("delete from messages where session_id = ? and seq > ?").run(
    user.sessionId,
    user.seq,
  );
  db.query(
    "update messages set send_id = ? where id = ? and kind = 'user'",
  ).run(newSendId, user.id);
  db.query("delete from sends where id = ?").run(user.sendId);
  const raw = db
    .query<RawMessage, [string]>(
      `select ${MESSAGE_COLUMNS} from messages where id = ?`,
    )
    .get(user.id)!;
  return { user: message(raw), removedMessageIds };
}
