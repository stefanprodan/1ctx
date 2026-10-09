// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's work as its root's watchers and the child route see it
// (docs/subagents.md): keyed by the root's delegate row, never by the
// child's own id, which no route or watch reaches.

import type { ChildWork, Message } from "../../shared/contracts/session.ts";
import type { SessionStatus } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { offWire } from "./rows.ts";

type TallyRaw = { status: SessionStatus; tokens: number };

// the child's status and its context, its last round's tokens, with
// the rows given; null when the session is gone or is no child. A sum
// of rounds re-counts the history each round sends, so it reads as
// many times the context
export function childWork(
  db: Db,
  sessionId: string,
  rows: Message[],
): ChildWork | null {
  const raw = db
    .query<TallyRaw, [string]>(
      `select sessions.status,
         coalesce((select prompt_tokens + completion_tokens
            from usage where usage.session_id = sessions.id
            order by seq desc limit 1), 0) as tokens
       from sessions
       where id = ? and parent_session_id is not null`,
    )
    .get(sessionId);
  if (raw === null) return null;
  return {
    sessionId,
    status: raw.status,
    tokens: raw.tokens,
    rows: rows.map(offWire),
  };
}

// the frame for the root's watchers, built inside the child's
// transaction so its status and tally are the commit's
export function childChanged(
  db: Db,
  fields: {
    projectId: string;
    rootId: string;
    messageId: string;
    childId: string;
    rows: Message[];
  },
): BusEvent[] {
  const child = childWork(db, fields.childId, fields.rows);
  if (child === null) return [];
  return [
    {
      type: "child.changed",
      data: {
        projectId: fields.projectId,
        sessionId: fields.rootId,
        messageId: fields.messageId,
        child,
      },
    },
  ];
}

// the children whose delegate row still runs, oldest call first
export function runningChildren(
  db: Db,
  rootId: string,
): { messageId: string; sessionId: string }[] {
  return db
    .query<{ messageId: string; sessionId: string }, [string]>(
      `select messages.id as messageId, sessions.id as sessionId
       from messages
       join sessions on sessions.parent_message_id = messages.id
       where messages.session_id = ? and messages.status = 'streaming'
       order by messages.seq`,
    )
    .all(rootId);
}

// the child a row of the root started, read by its links alone
export function childAt(
  db: Db,
  rootId: string,
  messageId: string,
): string | null {
  return (
    db
      .query<{ id: string }, [string, string]>(
        `select id from sessions
         where parent_session_id = ? and parent_message_id = ?`,
      )
      .get(rootId, messageId)?.id ?? null
  );
}

// whether the session is a child of the root, as a child's tool row is
// read under its root
export function childOf(db: Db, sessionId: string, rootId: string): boolean {
  return (
    db
      .query<{ one: number }, [string, string]>(
        "select 1 as one from sessions where id = ? and parent_session_id = ?",
      )
      .get(sessionId, rootId) !== null
  );
}
