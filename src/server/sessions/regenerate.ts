// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rows after the last user message may belong to compact sends, so
// every send in the replaced tail goes, not only the user messages'.
// Their usage rows stay: a replaced turn was still spent.

import type { Message } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import { readMessage } from "./messages.ts";

// users: the turn's user messages in seq order, nothing but them between
// the first and the last
export function replaceSendRows(
  db: Db,
  users: readonly Message[],
  newSendId: string,
): {
  users: Message[];
  removedMessageIds: string[];
} {
  const first = users[0]!;
  const last = users.at(-1)!;
  const tail = db
    .query<{ id: string; send_id: string }, [string, number]>(
      `select id, send_id from messages
       where session_id = ? and seq >= ? order by seq`,
    )
    .all(first.sessionId, first.seq);
  const removedMessageIds = tail.slice(users.length).map((row) => row.id);
  const removedSendIds = [...new Set(tail.map((row) => row.send_id))];
  db.query("delete from messages where session_id = ? and seq > ?").run(
    last.sessionId,
    last.seq,
  );
  const move = db.query(
    "update messages set send_id = ? where id = ? and kind = 'user'",
  );
  for (const user of users) move.run(newSendId, user.id);
  const remove = db.query("delete from sends where id = ?");
  for (const sendId of removedSendIds) remove.run(sendId);
  return {
    users: users.map((user) => readMessage(db, user.id)!),
    removedMessageIds,
  };
}
