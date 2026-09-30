// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The messages sent to a busy chat, kept apart from the transcript until
// a turn takes them: queued while they wait, not sent once they cannot
// start. The runner's dispatcher starts them; every change here is in
// the caller's transaction, which bumps the session's revision once.

import type { NotSentRow } from "../../shared/api/sessions.ts";
import type { CapabilityChange } from "../../shared/capabilities.ts";
import {
  QUEUED_PREVIEW,
  type QueuedMessage,
} from "../../shared/contracts/session.ts";
import type { NotSentReason, QueuedState } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { newId } from "../lib/ids.ts";
import { lineFrom } from "./parse.ts";

// a chat's queue starts as one turn, so it holds at most what one turn
// opens with
export const MAX_QUEUED_PER_CHAT = 16;
// the hourly sweep deletes a not-sent message this long after it turned
export const NOT_SENT_KEPT_MS = 7 * 86_400_000;

export type QueuedRow = {
  id: string;
  sessionId: string;
  authorId: string;
  text: string;
  uploads: string[];
  capabilities: CapabilityChange | undefined;
  state: QueuedState;
  reason: NotSentReason | null;
  revision: number;
  queuedAt: number;
  changedAt: number;
};

type RawQueued = {
  id: string;
  session_id: string;
  author_id: string;
  content: string;
  uploads: string | null;
  capabilities: string | null;
  state: QueuedState;
  reason: NotSentReason | null;
  revision: number;
  queued_at: number;
  changed_at: number;
};

const COLUMNS = `id, session_id, author_id, content, uploads, capabilities,
  state, reason, revision, queued_at, changed_at`;

const row = (raw: RawQueued): QueuedRow => ({
  id: raw.id,
  sessionId: raw.session_id,
  authorId: raw.author_id,
  text: raw.content,
  uploads: raw.uploads === null ? [] : JSON.parse(raw.uploads),
  capabilities:
    raw.capabilities === null ? undefined : JSON.parse(raw.capabilities),
  state: raw.state,
  reason: raw.reason,
  revision: raw.revision,
  queuedAt: raw.queued_at,
  changedAt: raw.changed_at,
});

// the text cut at QUEUED_PREVIEW characters, never inside a surrogate
// pair
function preview(text: string): { text: string; cut: boolean } {
  if (text.length <= QUEUED_PREVIEW) return { text, cut: false };
  let end = QUEUED_PREVIEW;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), cut: true };
}

// a row on the wire: whole for the detail and an answer, a preview on
// a socket frame, which goes to every watcher and must stay small
export const onWire = (
  queued: QueuedRow,
  username: string,
  cut = false,
): QueuedMessage => ({
  id: queued.id,
  author: { id: queued.authorId, username },
  ...(cut ? preview(queued.text) : { text: queued.text, cut: false }),
  uploads: queued.uploads.length,
  state: queued.state,
  reason: queued.reason,
  revision: queued.revision,
  queuedAt: queued.queuedAt,
});

// a chat's rows on the wire, oldest first: every queued one, and the
// viewer's not sent (none for a null viewer); mine: the viewer's not
// sent alone; cut: previews, for a socket frame
export function chatQueue(
  db: Db,
  sessionId: string,
  viewerId: string | null,
  { mine = false, cut = false }: { mine?: boolean; cut?: boolean } = {},
): QueuedMessage[] {
  const which = mine
    ? "q.state = 'not-sent' and q.author_id = ?"
    : "(q.state = 'queued' or q.author_id = ?)";
  return db
    .query<RawQueued & { username: string }, [string, string]>(
      `select q.id, q.session_id, q.author_id, q.content, q.uploads,
         q.capabilities, q.state, q.reason, q.revision, q.queued_at,
         q.changed_at, u.username
       from queued_messages q join users u on u.id = q.author_id
       where q.session_id = ? and ${which}
       order by q.queued_at, q.rowid`,
    )
    .all(sessionId, viewerId ?? "")
    .map((raw) => onWire(row(raw), raw.username, cut));
}

const chatOf = (db: Db, sessionId: string) =>
  db
    .query<{ project_id: string; revision: number }, [string]>(
      "select project_id, revision from sessions where id = ?",
    )
    .get(sessionId);

// the chat's queued rows for its watchers, at its revision now; turn
// when the commit that made it started a turn from them
export function queueFrameEvent(
  db: Db,
  sessionId: string,
  turn: boolean,
): BusEvent[] {
  const chat = chatOf(db, sessionId);
  if (chat === null) return [];
  return [
    {
      type: "queue.changed",
      data: {
        projectId: chat.project_id,
        sessionId,
        revision: chat.revision,
        turn,
        rows: chatQueue(db, sessionId, null, { cut: true }),
      },
    },
  ];
}

// in the caller's transaction: the chat's revision bumped, never its
// activity, and no project-wide envelope, since nothing a list shows
// moved. When the queued rows changed (shared), they go to the chat's
// watchers as previews; to each author named, their own not-sent rows
// in the chat, which only they may see. Nothing for a chat gone
export function queueChanged(
  db: Db,
  sessionId: string,
  { shared, authors = [] }: { shared: boolean; authors?: Iterable<string> },
): BusEvent[] {
  db.query("update sessions set revision = revision + 1 where id = ?").run(
    sessionId,
  );
  const chat = chatOf(db, sessionId);
  if (chat === null) return [];
  const events = shared ? queueFrameEvent(db, sessionId, false) : [];
  for (const userId of new Set(authors)) {
    events.push({
      type: "queue.mine",
      data: {
        userId,
        projectId: chat.project_id,
        sessionId,
        revision: chat.revision,
        rows: chatQueue(db, sessionId, userId, { mine: true, cut: true }),
      },
    });
  }
  return events;
}

export type WaitingCursor = { sessionId: string; queuedAt: number };

export type QueueLoad = {
  queued: number;
  notSent: number;
  oldestQueuedAt: number | null;
};

export class QueueStore {
  constructor(private readonly db: Db) {}

  insert(fields: {
    sessionId: string;
    authorId: string;
    text: string;
    uploads?: readonly string[];
    capabilities?: CapabilityChange;
    now: number;
  }): QueuedRow {
    const id = newId();
    this.db
      .query(
        `insert into queued_messages (id, session_id, author_id, content,
           uploads, capabilities, queued_at, changed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.sessionId,
        fields.authorId,
        fields.text,
        fields.uploads?.length ? JSON.stringify(fields.uploads) : null,
        fields.capabilities === undefined
          ? null
          : JSON.stringify(fields.capabilities),
        fields.now,
        fields.now,
      );
    return this.byId(id)!;
  }

  byId(id: string): QueuedRow | null {
    const raw = this.db
      .query<RawQueued, [string]>(
        `select ${COLUMNS} from queued_messages where id = ?`,
      )
      .get(id);
    return raw === null ? null : row(raw);
  }

  // the rows a start takes, oldest first
  waiting(sessionId: string, limit = MAX_QUEUED_PER_CHAT): QueuedRow[] {
    return this.db
      .query<RawQueued, [string, number]>(
        `select ${COLUMNS} from queued_messages
         where session_id = ? and state = 'queued'
         order by queued_at, rowid limit ?`,
      )
      .all(sessionId, limit)
      .map(row);
  }

  // what the detail shows: every queued row, and the viewer's not sent
  ofChat(sessionId: string, viewerId: string | null): QueuedMessage[] {
    return chatQueue(this.db, sessionId, viewerId);
  }

  chatCount(sessionId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from queued_messages where session_id = ? and state = 'queued'",
      )
      .get(sessionId)!.n;
  }

  // queued and not sent together, the rows queuedPerUser bounds
  userCount(userId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from queued_messages where author_id = ?",
      )
      .get(userId)!.n;
  }

  // the author's new text on a row still queued; queued_at stays
  edit(
    id: string,
    revision: number,
    text: string,
    now: number,
  ): QueuedRow | null {
    const changed =
      this.db
        .query(
          `update queued_messages set content = ?, revision = revision + 1,
             changed_at = ?
           where id = ? and revision = ? and state = 'queued'`,
        )
        .run(text, now, id, revision).changes > 0;
    return changed ? this.byId(id) : null;
  }

  remove(id: string, revision: number): boolean {
    return (
      this.db
        .query("delete from queued_messages where id = ? and revision = ?")
        .run(id, revision).changes > 0
    );
  }

  // a start deletes the rows it takes by id and revision; false when any
  // changed or went, and the caller's transaction then writes nothing
  claim(
    sessionId: string,
    claims: readonly { id: string; revision: number }[],
  ): boolean {
    const del = this.db.query(
      `delete from queued_messages
       where id = ? and revision = ? and session_id = ? and state = 'queued'`,
    );
    let taken = 0;
    for (const claim of claims) {
      taken += del.run(claim.id, claim.revision, sessionId).changes;
    }
    return taken === claims.length;
  }

  // the rows still queued at the revision seen turn not sent; how many
  notSend(
    rows: readonly { id: string; revision: number }[],
    reason: NotSentReason,
    now: number,
  ): number {
    const update = this.db.query(
      `update queued_messages set state = 'not-sent', reason = ?,
         revision = revision + 1, changed_at = ?
       where id = ? and revision = ? and state = 'queued'`,
    );
    let changed = 0;
    for (const { id, revision } of rows) {
      changed += update.run(reason, now, id, revision).changes;
    }
    return changed;
  }

  drop(ids: readonly string[]): number {
    const del = this.db.query("delete from queued_messages where id = ?");
    let dropped = 0;
    for (const id of ids) dropped += del.run(id).changes;
    return dropped;
  }

  // a page of queued rows past the cursor, oldest first, in the chats
  // the runner does not hold: a keyset walk of the partial index, one
  // indexed read when nothing waits. A chat shows once per row, and its
  // oldest row comes first
  waitingRows(
    held: readonly string[],
    after: WaitingCursor | null,
    limit: number,
  ): WaitingCursor[] {
    return this.db
      .query<
        { session_id: string; queued_at: number },
        [number, string, string, number]
      >(
        `select session_id, queued_at from queued_messages
         indexed by queued_waiting
         where state = 'queued' and (queued_at, session_id) > (?, ?)
           and session_id not in (select value from json_each(?))
         order by queued_at, session_id limit ?`,
      )
      .all(
        after?.queuedAt ?? -1,
        after?.sessionId ?? "",
        JSON.stringify(held),
        limit,
      )
      .map((r) => ({ sessionId: r.session_id, queuedAt: r.queued_at }));
  }

  // the chats with a row queued at or before the time
  expiredChats(before: number, limit: number): string[] {
    return this.db
      .query<{ session_id: string }, [number, number]>(
        `select distinct session_id from queued_messages
         indexed by queued_waiting
         where state = 'queued' and queued_at <= ?
         limit ?`,
      )
      .all(before, limit)
      .map((r) => r.session_id);
  }

  oldestQueuedAt(): number | null {
    return (
      this.db
        .query<{ at: number | null }, []>(
          "select min(queued_at) as at from queued_messages where state = 'queued'",
        )
        .get()?.at ?? null
    );
  }

  // Home's list: the author's not-sent rows in the projects they see,
  // newest first
  notSentOf(userId: string, projectIds: readonly string[]): NotSentRow[] {
    return this.db
      .query<
        {
          id: string;
          session_id: string;
          title: string;
          project: string;
          agent: string;
          content: string;
          reason: NotSentReason;
          changed_at: number;
        },
        [string, string]
      >(
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
      .all(userId, JSON.stringify(projectIds))
      .map((raw) => ({
        id: raw.id,
        sessionId: raw.session_id,
        title: raw.title,
        project: raw.project,
        agent: raw.agent,
        line: lineFrom(raw.content),
        reason: raw.reason,
        changedAt: raw.changed_at,
      }));
  }

  // the author's not-sent rows named gone, in the projects they see as
  // Home lists them, any other id passed over; the chats they were in
  discardNotSent(
    userId: string,
    ids: readonly string[],
    projectIds: readonly string[],
  ): string[] {
    return this.db
      .query<{ session_id: string }, [string, string, string]>(
        `delete from queued_messages
         where author_id = ? and state = 'not-sent'
           and id in (select value from json_each(?))
           and exists (select 1 from sessions s
             where s.id = queued_messages.session_id
               and s.project_id in (select value from json_each(?)))
         returning session_id`,
      )
      .all(userId, JSON.stringify(ids), JSON.stringify(projectIds))
      .map((r) => r.session_id);
  }

  // the author's rows in a project they no longer see; the chats
  dropInProject(projectId: string, userId: string): string[] {
    return this.db
      .query<{ session_id: string }, [string, string]>(
        `delete from queued_messages
         where author_id = ?
           and exists (select 1 from sessions s
             where s.id = queued_messages.session_id and s.project_id = ?)
         returning session_id`,
      )
      .all(userId, projectId)
      .map((r) => r.session_id);
  }

  // not-sent rows past their keeping gone; each one's chat and author
  sweep(now: number): { sessionId: string; authorId: string }[] {
    return this.db
      .query<{ session_id: string; author_id: string }, [number]>(
        `delete from queued_messages
         where state = 'not-sent' and changed_at < ?
         returning session_id, author_id`,
      )
      .all(now - NOT_SENT_KEPT_MS)
      .map((r) => ({ sessionId: r.session_id, authorId: r.author_id }));
  }

  load(): QueueLoad {
    return this.db
      .query<QueueLoad, []>(
        `select
           (select count(*) from queued_messages where state = 'queued')
             as queued,
           (select count(*) from queued_messages where state = 'not-sent')
             as notSent,
           (select min(queued_at) from queued_messages where state = 'queued')
             as oldestQueuedAt`,
      )
      .get()!;
  }
}
