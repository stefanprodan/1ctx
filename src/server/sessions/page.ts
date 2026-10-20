// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import {
  MESSAGE_COLUMNS,
  message,
  type RawMessage,
  type RawSend,
  send,
  sendTokens,
} from "./rows.ts";

export const CHANNEL_PAGE_TURNS = 50;

type Anchor = { id: string; seq: number };
export type ChannelPage = {
  messages: Message[];
  // the agent turns among the rows, by primary key
  sends: SendSummary[];
  before: number | null;
  after: number | null;
};

const anchorsBefore = (
  db: Db,
  sessionId: string,
  before: number | null,
  limit: number,
): Anchor[] =>
  db
    .query<Anchor, [string, number | null, number | null, number]>(
      `select messages.id, messages.seq from messages
       join sends on sends.id = messages.send_id
       where messages.session_id = ? and messages.kind = 'user'
         and sends.kind = 'post' and (? is null or messages.seq < ?)
       order by messages.seq desc limit ?`,
    )
    .all(sessionId, before, before, limit);

const around = (db: Db, sessionId: string, seq: number): Anchor[] => {
  const older = anchorsBefore(
    db,
    sessionId,
    seq + 1,
    Math.floor(CHANNEL_PAGE_TURNS / 2) + 1,
  );
  const newer = db
    .query<Anchor, [string, number, number]>(
      `select messages.id, messages.seq from messages
       join sends on sends.id = messages.send_id
       where messages.session_id = ? and messages.kind = 'user'
         and sends.kind = 'post' and messages.seq > ?
       order by messages.seq limit ?`,
    )
    .all(sessionId, seq, Math.floor(CHANNEL_PAGE_TURNS / 2));
  return [...older.reverse(), ...newer];
};

export function channelPage(
  db: Db,
  sessionId: string,
  cursor: { before: number | null; around: number | null },
): ChannelPage {
  const raw =
    cursor.around === null
      ? anchorsBefore(db, sessionId, cursor.before, CHANNEL_PAGE_TURNS + 1)
      : around(db, sessionId, cursor.around);
  const ordered = [...raw].sort((a, b) => a.seq - b.seq);
  const selected =
    cursor.around === null
      ? ordered.slice(Math.max(0, ordered.length - CHANNEL_PAGE_TURNS))
      : ordered.slice(0, CHANNEL_PAGE_TURNS);
  if (selected.length === 0) {
    return { messages: [], sends: [], before: null, after: null };
  }
  const ids = JSON.stringify(selected.map((row) => row.id));
  const rows = db
    .query<RawMessage, [string, string]>(
      `select ${MESSAGE_COLUMNS} from messages
       where +messages.session_id = ? and messages.send_id in (
         select post.send_id from messages post
          where post.id in (select value from json_each(?2))
         union
         select sends.id from sends
          where sends.session_id = ?1
            and sends.first_message_id in (select value from json_each(?2))
       ) order by messages.seq`,
    )
    .all(sessionId, ids)
    .map(message);
  const sends = db
    .query<RawSend, [string, string]>(
      `select *, ${sendTokens("sends")} from sends
       where id in (select value from json_each(?2))
         and session_id = ?1 and kind != 'post'
       order by started_at, rowid`,
    )
    .all(sessionId, JSON.stringify([...new Set(rows.map((r) => r.sendId))]))
    .map(send);
  const first = selected[0]!.seq;
  const last = selected.at(-1)!.seq;
  const older = db
    .query<{ found: number }, [string, number]>(
      `select exists (
         select 1 from messages join sends on sends.id = messages.send_id
          where messages.session_id = ? and messages.kind = 'user'
            and sends.kind = 'post' and messages.seq < ?
       ) as found`,
    )
    .get(sessionId, first)!.found;
  const newer = db
    .query<{ found: number }, [string, number]>(
      `select exists (
         select 1 from messages join sends on sends.id = messages.send_id
          where messages.session_id = ? and messages.kind = 'user'
            and sends.kind = 'post' and messages.seq > ?
       ) as found`,
    )
    .get(sessionId, last)!.found;
  return {
    messages: rows,
    sends,
    before: older === 1 ? first : null,
    after: newer === 1 ? last : null,
  };
}
