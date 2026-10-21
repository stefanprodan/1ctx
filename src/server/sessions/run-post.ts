// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A finished run's answer posted to its project's channel: one reply row
// under a post send naming the run's agent and its automation's owner,
// holding the run's calls and its session, never its results.

import type {
  Message,
  SendSummary,
  TraceCall,
} from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import { newId } from "../lib/ids.ts";
import { envelope } from "./envelope.ts";
import { nextSeq, readMessage, readSendMessages } from "./messages.ts";
import {
  MESSAGE_COLUMNS,
  message,
  type RawMessage,
  type RawSession,
  type SessionRow,
  session,
  type UsagePort,
} from "./rows.ts";
import { insertPostSend, readSend } from "./sends.ts";

export type RunPostFields = {
  runSessionId: string;
  runSendId: string;
  agentId: string;
  now: number;
  // the run's calls from its rows up to the answer
  calls(rows: readonly Message[]): TraceCall[];
};

export type RunPosted = {
  channel: SessionRow;
  message: Message;
  send: SendSummary;
};

// in the caller's transaction, after the run's answer is final; null
// when its automation does not post or the answer is empty
export function postRun(
  db: Db,
  usage: UsagePort,
  fields: RunPostFields,
): RunPosted | null {
  const target = db
    .query<{ channel_id: string; owner_id: string }, [string]>(
      `select channels.id as channel_id, automations.owner_id
       from sessions runs
       join automations on automations.id = runs.automation_id
       join sessions channels on channels.project_id = runs.project_id
         and channels.origin = 'channel'
         and channels.parent_session_id is null
       where runs.id = ? and runs.parent_session_id is null
         and automations.post_to_channel = 1`,
    )
    .get(fields.runSessionId);
  if (target === null) return null;
  const raw = db
    .query<RawMessage, [string]>(
      `select ${MESSAGE_COLUMNS} from messages
       where send_id = ? and slot = 'answer'`,
    )
    .get(fields.runSendId);
  const answer = raw === null ? null : message(raw);
  if (answer?.status !== "done" || answer.content.trim() === "") return null;
  // the memory and attention steps come after the answer and are the
  // run's own bookkeeping, not how it found the answer
  const rows = readSendMessages(db, fields.runSendId).filter(
    (row) => row.round <= answer.round,
  );
  const id = newId();
  const sendId = insertPostSend(db, {
    sessionId: target.channel_id,
    userId: target.owner_id,
    agentId: fields.agentId,
    firstMessageId: id,
    now: fields.now,
  });
  db.query(
    `insert into messages (id, session_id, seq, kind, send_id, round, slot,
       agent_id, model, content, html, status, finish_reason, run_calls,
       run_session_id, created_at, finished_at)
     values (?, ?, ?, 'reply', ?, 1, 'answer', ?, ?, ?, ?, 'done', ?, ?, ?,
       ?, ?)`,
  ).run(
    id,
    target.channel_id,
    nextSeq(db, target.channel_id),
    sendId,
    fields.agentId,
    answer.model,
    answer.content,
    answer.html,
    answer.finishReason,
    JSON.stringify(fields.calls(rows)),
    fields.runSessionId,
    fields.now,
    fields.now,
  );
  db.query(
    "update sessions set last_activity_at = ?, revision = revision + 1 where id = ?",
  ).run(fields.now, target.channel_id);
  return {
    channel: sessionOf(db, usage, target.channel_id)!,
    message: readMessage(db, id)!,
    send: readSend(db, sendId)!,
  };
}

const sessionOf = (db: Db, usage: UsagePort, id: string): SessionRow | null => {
  const raw = db
    .query<RawSession, [string]>("select * from sessions where id = ?")
    .get(id);
  return raw === null ? null : session(raw, usage.latest(raw.id));
};

// every run of the automation in the caller's transaction, in one
// statement however many runs it kept; their usage stays. The events
// are the channels whose posts linked them
export function deleteAutomationRuns(
  db: Db,
  usage: UsagePort,
  automationId: string,
): BusEvent[] {
  const unlinked = runPostsUnlinked(db, usage, { automationId });
  db.query("delete from sessions where automation_id = ?").run(automationId);
  return unlinked();
}

// in the caller's transaction, before the runs go: the channel rows that
// link them, whose link the foreign key clears without a revision. Each
// channel moves its revision once and publishes the rows with the link
// gone, so a page drops it
export function runPostsUnlinked(
  db: Db,
  usage: UsagePort,
  where: { sessionId: string } | { automationId: string },
): () => BusEvent[] {
  const linked = db
    .query<{ id: string; session_id: string }, [string]>(
      "sessionId" in where
        ? `select id, session_id from messages where run_session_id = ?`
        : `select messages.id, messages.session_id from sessions runs
           join messages on messages.run_session_id = runs.id
           where runs.automation_id = ?`,
    )
    .all("sessionId" in where ? where.sessionId : where.automationId);
  return () => {
    const byChannel = new Map<string, string[]>();
    for (const row of linked) {
      byChannel.set(row.session_id, [
        ...(byChannel.get(row.session_id) ?? []),
        row.id,
      ]);
    }
    return [...byChannel].flatMap(([channelId, ids]) => {
      db.query("update sessions set revision = revision + 1 where id = ?").run(
        channelId,
      );
      const channel = sessionOf(db, usage, channelId);
      if (channel === null) return [];
      const changed = ids.flatMap((id) => readMessage(db, id) ?? []);
      return [envelope(channel, changed, null)];
    });
  };
}

// the store's side of a run's posts, in the caller's transaction
export class RunPostStore {
  constructor(
    private readonly db: Db,
    private readonly usage: UsagePort,
  ) {}

  post(fields: RunPostFields): RunPosted | null {
    return postRun(this.db, this.usage, fields);
  }

  deleteRuns(automationId: string): BusEvent[] {
    return deleteAutomationRuns(this.db, this.usage, automationId);
  }
}
