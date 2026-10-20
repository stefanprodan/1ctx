// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";
import { transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { DAY_MS } from "../lib/clock.ts";
import { errorFields, type Log } from "../lib/log.ts";
import type { ChatCaps } from "../limits/index.ts";
import { ROOT } from "./children.ts";
import type { DraftsPort } from "./drafts.ts";
import { envelope } from "./envelope.ts";
import { readSendMessages } from "./messages.ts";
import { PACKABLE } from "./pack.ts";
import type { SessionRow } from "./rows.ts";
import type { SessionStore } from "./store.ts";

export const CHATS_PER_STEP = 500;

// the scratch the sweep frees, and the sessions a command holds now,
// which it leaves be as the bash sweep does
export type SweepScratch = {
  drop(sessionId: string): void;
  held(): ReadonlySet<string>;
};

export type SweepDeps = {
  db: Db;
  store: SessionStore;
  scratch: SweepScratch;
  log: Log;
  drafts?: Pick<DraftsPort, "expired" | "expire">;
};

// the fields of the sweep event, snake case like the startup event's
export type ChatSweep = {
  turns_swept: number;
  chats_archived: number;
  chats_packed: number;
  scratch_freed: number;
  runs_packed: number;
  chats_deleted: number;
  runs_deleted: number;
  drafts_expired: number;
};

// the roots that ended and still hold a result worth packing, theirs
// or a child's; a child is packed with its root, never alone
const packable = (db: Db, which: string, limit: number): string[] =>
  db
    .query<{ id: string }, [number]>(
      `select id from sessions
       where ${which} and ${ROOT} and status <> 'running'
         and (exists (select 1 from messages
             where messages.session_id = sessions.id and ${PACKABLE})
           or exists (select 1 from sessions child
             join messages on messages.session_id = child.id
             where child.parent_session_id = sessions.id and ${PACKABLE}))
       order by last_activity_at, id limit ?`,
    )
    .all(limit)
    .map((row) => row.id);

type Step = {
  field: keyof ChatSweep;
  // the chats this step may act on, oldest first
  candidates(now: number, caps: ChatCaps, limit: number): string[];
  // in the chat's transaction: its events when it acted, null when the
  // row changed since it was picked
  apply(id: string, now: number, caps: ChatCaps): BusEvent[] | null;
};

function steps(deps: SweepDeps): Step[] {
  const { db, store } = deps;
  const idleBefore = (now: number, caps: ChatCaps) =>
    now - caps.archiveIdleDays * DAY_MS;
  const deleteBefore = (now: number, caps: ChatCaps) =>
    now - caps.archivedDeleteDays * DAY_MS;
  // a pack never touches a running session: its next round and a run's
  // memory phase read the content
  const pack = (id: string, ours: (row: SessionRow) => boolean) => {
    const current = store.byId(id);
    if (current === null || current.status === "running" || !ours(current)) {
      return null;
    }
    return store.pack(id) > 0 ? [] : null;
  };
  const remove = (id: string) => {
    const deleted = store.remove(id);
    return deleted === null || deleted === "running" ? null : [deleted];
  };
  return [
    {
      field: "drafts_expired",
      candidates: (now, _caps, limit) => deps.drafts?.expired(now, limit) ?? [],
      apply: (id, now) => (deps.drafts?.expire(id, now) ? [] : null),
    },
    {
      field: "turns_swept",
      candidates: (now, caps, limit) =>
        db
          .query<{ id: string }, [number, number]>(
            `select sends.id from sessions indexed by sessions_channel
             cross join sends indexed by sends_channel_unswept
               on sends.session_id = sessions.id
             where sessions.origin = 'channel'
               and sessions.parent_session_id is null
               and sends.swept = 0 and sends.child = 0
               and sends.kind <> 'post' and sends.status <> 'running'
               and sends.finished_at < ?
             order by sends.finished_at, sends.id limit ?`,
          )
          .all(idleBefore(now, caps), limit)
          .map((row) => row.id),
      apply(id, now, caps) {
        const current = db
          .query<
            { session_id: string; status: string; finished_at: number | null },
            [string, number]
          >(
            `select sends.session_id, sends.status, sends.finished_at
             from sends join sessions on sessions.id = sends.session_id
             where sends.id = ? and sends.swept = 0 and sends.child = 0
               and sends.kind <> 'post' and sends.status <> 'running'
               and sends.finished_at < ? and sessions.origin = 'channel'`,
          )
          .get(id, idleBefore(now, caps));
        if (current === null) return null;
        db.query(
          `update messages set content = '', reasoning = '',
             reasoning_details = null, packed = null, packed_bytes = null
           where send_id = ? and kind = 'tool'`,
        ).run(id);
        db.query(
          `delete from opened_files where message_id in
             (select id from messages where send_id = ? and kind = 'tool')`,
        ).run(id);
        db.query(
          `delete from mcp_kept_files where message_id in
             (select id from messages where send_id = ? and kind = 'tool')`,
        ).run(id);
        db.query(
          `delete from sessions where parent_message_id in
             (select id from messages where send_id = ? and kind = 'tool')`,
        ).run(id);
        const marked = db
          .query(
            `update sends set swept = 1
             where id = ? and swept = 0 and status <> 'running'`,
          )
          .run(id).changes;
        if (marked !== 1) return null;
        db.query(
          "update sessions set revision = revision + 1 where id = ?",
        ).run(current.session_id);
        const session = store.byId(current.session_id);
        return session === null
          ? null
          : [envelope(session, readSendMessages(db, id), store.send(id))];
      },
    },
    {
      field: "chats_archived",
      // over sessions_idle, whose predicate the where repeats
      candidates: (now, caps, limit) =>
        db
          .query<{ id: string }, [number, number]>(
            `select id from sessions
             where origin = 'chat' and archived_at is null and ${ROOT}
               and last_activity_at < ? and status <> 'running'
             order by last_activity_at limit ?`,
          )
          .all(idleBefore(now, caps), limit)
          .map((row) => row.id),
      apply(id, now, caps) {
        const current = store.byId(id);
        if (
          current === null ||
          current.origin !== "chat" ||
          current.status === "running" ||
          current.lastActivityAt >= idleBefore(now, caps)
        ) {
          return null;
        }
        const row = store.archive(id, "idle", null, now);
        return row === null ? null : [envelope(row, [], store.lastSend(id))];
      },
    },
    {
      // an agent's delete archives a chat that may still run and packs
      // nothing; a chat archived by hand or idle was packed then
      field: "chats_packed",
      candidates: (_now, _caps, limit) =>
        packable(db, "origin = 'chat' and archived_at is not null", limit),
      apply: (id) => pack(id, (row) => row.archived !== null),
    },
    {
      // a chat archived while its send ran could write scratch until
      // the stop landed; the join reads the bash area's table
      field: "scratch_freed",
      candidates: (_now, _caps, limit) => {
        const held = deps.scratch.held();
        return db
          .query<{ id: string }, [number]>(
            `select sessions.id as id from sessions
             join session_scratch on session_scratch.session_id = sessions.id
             where sessions.archived_at is not null
               and sessions.status <> 'running'
             limit ?`,
          )
          .all(limit)
          .map((row) => row.id)
          .filter((id) => !held.has(id));
      },
      apply(id) {
        const current = store.byId(id);
        if (
          current === null ||
          current.archived === null ||
          current.status === "running" ||
          deps.scratch.held().has(id)
        ) {
          return null;
        }
        deps.scratch.drop(id);
        return [];
      },
    },
    {
      // a run takes no turn once it ends, its memory phase included,
      // which runs under the same running status; never at its end, so
      // a run's finish adds no write
      field: "runs_packed",
      candidates: (_now, _caps, limit) =>
        packable(db, "origin = 'automation'", limit),
      apply: (id) => pack(id, (row) => row.origin === "automation"),
    },
    {
      field: "chats_deleted",
      candidates: (now, caps, limit) =>
        db
          .query<{ id: string }, [number, number]>(
            `select id from sessions
             where origin = 'chat' and archived_at < ? and ${ROOT}
               and status <> 'running'
             order by archived_at limit ?`,
          )
          .all(deleteBefore(now, caps), limit)
          .map((row) => row.id),
      apply(id, now, caps) {
        const current = store.byId(id);
        if (
          current?.archived == null ||
          current.archived.at >= deleteBefore(now, caps)
        ) {
          return null;
        }
        return remove(id);
      },
    },
    {
      // a live automation's runs keep its retention; a deleted one leaves its
      // runs with no automation, which that retention never reaches
      field: "runs_deleted",
      candidates: (now, caps, limit) =>
        db
          .query<{ id: string }, [number, number]>(
            `select id from sessions
             where origin = 'automation' and automation_id is null
               and ${ROOT} and last_activity_at < ? and status <> 'running'
             order by last_activity_at limit ?`,
          )
          .all(deleteBefore(now, caps), limit)
          .map((row) => row.id),
      apply(id, now, caps) {
        const current = store.byId(id);
        if (
          current === null ||
          current.origin !== "automation" ||
          current.automationId !== null ||
          current.lastActivityAt >= deleteBefore(now, caps)
        ) {
          return null;
        }
        return remove(id);
      },
    },
  ];
}

export function sweepChats(
  deps: SweepDeps,
  now: number,
  caps: ChatCaps,
  perStep = CHATS_PER_STEP,
): ChatSweep {
  const counts: ChatSweep = {
    turns_swept: 0,
    chats_archived: 0,
    chats_packed: 0,
    scratch_freed: 0,
    runs_packed: 0,
    chats_deleted: 0,
    runs_deleted: 0,
    drafts_expired: 0,
  };
  for (const step of steps(deps)) {
    // a failed query skips its step, never the rest or the startup
    let ids: string[];
    try {
      ids = step.candidates(now, caps, perStep);
    } catch (err) {
      deps.log.warn("chat sweep failed", {
        step: step.field,
        ...errorFields(err, false),
      });
      continue;
    }
    for (const id of ids) {
      try {
        const acted = transact(deps.db, () => {
          const events = step.apply(id, now, caps);
          return { result: events !== null, events: events ?? [] };
        });
        if (acted) counts[step.field]++;
      } catch (err) {
        deps.log.warn("chat sweep failed", {
          ...(step.field === "turns_swept" ? { send: id } : { chat: id }),
          step: step.field,
          ...errorFields(err, false),
        });
      }
    }
  }
  return counts;
}
