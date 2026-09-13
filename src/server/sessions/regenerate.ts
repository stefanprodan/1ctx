// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Regeneration keeps the last user row, removes every row after it and
// assigns that row to the replacement send. Later rows may belong to
// compact sends, so every send represented by the replaced tail goes.

import type { Message } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import { MESSAGE_COLUMNS, message, type RawMessage } from "./rows.ts";

export function replaceSendRows(
  db: Db,
  user: Message,
  newSendId: string,
): {
  user: Message;
  removedMessageIds: string[];
  removedSendIds: string[];
} {
  const tail = db
    .query<{ id: string; send_id: string }, [string, number]>(
      `select id, send_id from messages
       where session_id = ? and seq >= ? order by seq`,
    )
    .all(user.sessionId, user.seq);
  const removedMessageIds = tail.slice(1).map((row) => row.id);
  const removedSendIds = [...new Set(tail.map((row) => row.send_id))];
  db.query("delete from messages where session_id = ? and seq > ?").run(
    user.sessionId,
    user.seq,
  );
  db.query(
    "update messages set send_id = ? where id = ? and kind = 'user'",
  ).run(newSendId, user.id);
  const remove = db.query("delete from sends where id = ?");
  for (const sendId of removedSendIds) remove.run(sendId);
  const raw = db
    .query<RawMessage, [string]>(
      `select ${MESSAGE_COLUMNS} from messages where id = ?`,
    )
    .get(user.id)!;
  return { user: message(raw), removedMessageIds, removedSendIds };
}
