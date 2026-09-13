// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type {
  MessageStatus,
  SendCause,
  SessionStatus,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import type { ReasoningDetail } from "../providers/index.ts";
import {
  MESSAGE_COLUMNS,
  message,
  type RawMessage,
  type RawSend,
  type RawSession,
  type RepairedSession,
  type ReplyFinish,
  type SessionRow,
  STREAM_LIMIT,
  send,
  session,
  type UsagePort,
} from "./rows.ts";

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly usage: UsagePort,
  ) {}

  byId(id: string): SessionRow | null {
    const raw = this.db
      .query<RawSession, [string]>("select * from sessions where id = ?")
      .get(id);
    return raw ? session(raw, this.usage.latest(raw.id)) : null;
  }

  // the stream: the sessions of the given projects, running first, then
  // by last activity, the title searched when there is a query
  list(projectIds: string[], q: string, limit = STREAM_LIMIT): SessionRow[] {
    if (projectIds.length === 0) return [];
    const marks = projectIds.map(() => "?").join(", ");
    const needle = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    const rows = this.db
      .query<RawSession, (string | number)[]>(
        `select * from sessions
         where project_id in (${marks})
           and (? = '' or title like ? escape '\\')
         order by status = 'running' desc, last_activity_at desc, id
         limit ?`,
      )
      .all(...projectIds, q, needle, limit);
    const usage = this.usage.latestFor(rows.map((r) => r.id));
    return rows.map((raw) => session(raw, usage.get(raw.id) ?? null));
  }

  // the id may come from the caller: the runner admits a new session
  // under its id before the row exists
  create(fields: {
    id?: string;
    projectId: string;
    ownerId: string;
    agentId: string;
    title: string;
    now: number;
  }): SessionRow {
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into sessions (id, project_id, owner_id, agent_id, origin, title,
           status, revision, created_at, last_activity_at)
         values (?, ?, ?, ?, 'chat', ?, 'running', 0, ?, ?)`,
      )
      .run(
        id,
        fields.projectId,
        fields.ownerId,
        fields.agentId,
        fields.title,
        fields.now,
        fields.now,
      );
    return this.byId(id)!;
  }

  // the one way a session changes: its status and activity move and
  // the revision counts it
  touch(
    id: string,
    fields: { status: SessionStatus; now: number },
  ): SessionRow | null {
    this.db
      .query(
        "update sessions set status = ?, last_activity_at = ?, revision = revision + 1 where id = ?",
      )
      .run(fields.status, fields.now, id);
    return this.byId(id);
  }

  delete(id: string): boolean {
    return (
      this.db.query("delete from sessions where id = ?").run(id).changes > 0
    );
  }

  usesAgent(agentId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from sessions where agent_id = ?",
        )
        .get(agentId)!.n > 0
    );
  }

  messages(sessionId: string): Message[] {
    return this.db
      .query<RawMessage, [string]>(
        `select ${MESSAGE_COLUMNS} from messages where session_id = ? order by seq`,
      )
      .all(sessionId)
      .map(message);
  }

  message(id: string): Message | null {
    const raw = this.db
      .query<RawMessage, [string]>(
        `select ${MESSAGE_COLUMNS} from messages where id = ?`,
      )
      .get(id);
    return raw ? message(raw) : null;
  }

  reasoningDetails(id: string): ReasoningDetail[] | null {
    const raw = this.db
      .query<{ reasoning_details: string | null }, [string]>(
        "select reasoning_details from messages where id = ?",
      )
      .get(id);
    if (!raw?.reasoning_details) return null;
    try {
      const parsed = JSON.parse(raw.reasoning_details);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  // the runner generates the ids before any insert and writes the send
  // row first, so send_id holds without a deferred foreign key. round
  // is the provider round the message belongs to, from 1
  addUserMessage(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    userId: string;
    content: string;
    now: number;
  }): Message {
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into messages (id, session_id, seq, kind, send_id, round, user_id, content, status, created_at, finished_at)
         values (?, ?, ?, 'user', ?, 1, ?, ?, 'done', ?, ?)`,
      )
      .run(
        id,
        fields.sessionId,
        this.nextSeq(fields.sessionId),
        fields.sendId,
        fields.userId,
        fields.content,
        fields.now,
        fields.now,
      );
    return this.message(id)!;
  }

  // a streaming reply for a round: a null slot until it is placed. The
  // first round of a send is round 1; startRound bumps it
  addReply(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    round: number;
    agentId: string;
    model: string;
    now: number;
  }): Message {
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into messages (id, session_id, seq, kind, send_id, round, agent_id, model, status, created_at)
         values (?, ?, ?, 'reply', ?, ?, ?, ?, 'streaming', ?)`,
      )
      .run(
        id,
        fields.sessionId,
        this.nextSeq(fields.sessionId),
        fields.sendId,
        fields.round,
        fields.agentId,
        fields.model,
        fields.now,
      );
    return this.message(id)!;
  }

  // the checkpoint of a reply in flight: what a crash keeps
  writeReply(
    id: string,
    fields: {
      content: string;
      reasoning: string;
      reasoningDetails: ReasoningDetail[];
    },
  ): boolean {
    return (
      this.db
        .query(
          "update messages set content = ?, reasoning = ?, reasoning_details = ? where id = ? and status = 'streaming'",
        )
        .run(
          fields.content,
          fields.reasoning,
          fields.reasoningDetails.length > 0
            ? JSON.stringify(fields.reasoningDetails)
            : null,
          id,
        ).changes > 0
    );
  }

  finishReply(id: string, fields: ReplyFinish): Message | null {
    const changed =
      this.db
        .query(
          `update messages set content = ?, reasoning = ?, reasoning_details = ?, html = ?,
           status = ?, error = ?, finish_reason = ?, slot = ?, tool_calls = ?,
           ttft_ms = ?, thinking_ms = ?, finished_at = ?
         where id = ? and status = 'streaming'`,
        )
        .run(
          fields.content,
          fields.reasoning,
          fields.reasoningDetails.length > 0
            ? JSON.stringify(fields.reasoningDetails)
            : null,
          fields.html,
          fields.status,
          fields.error,
          fields.finishReason,
          fields.slot,
          fields.toolCalls && fields.toolCalls.length > 0
            ? JSON.stringify(fields.toolCalls)
            : null,
          fields.ttftMs,
          fields.thinkingMs,
          fields.finishedAt,
          id,
        ).changes > 0;
    return changed ? this.message(id) : null;
  }

  // the row moves into the fold at the first call delta of a round: a
  // streaming reply with a null slot becomes "work". Guarded by the
  // null slot, so a second delta writes nothing and answers null
  markRoundWork(id: string): Message | null {
    const sql =
      "update messages set slot = 'work' where id = ? and kind = 'reply' and status = 'streaming' and slot is null";
    const changed = this.db.query(sql).run(id).changes > 0;
    return changed ? this.message(id) : null;
  }

  // place a reply's slot without ending it; the repair uses it to make
  // a null-slot reply it ends an "answer"
  markSlot(id: string, slot: "work" | "answer"): Message | null {
    const changed =
      this.db
        .query(
          "update messages set slot = ? where id = ? and kind = 'reply' and slot is null",
        )
        .run(slot, id).changes > 0;
    return changed ? this.message(id) : null;
  }

  // one streaming tool row per launched call: the call id and tool name
  // the row answers, the content filled when the tool ends. The ids and
  // seqs come in order from the caller so a batch is one statement's
  // worth of rows
  addToolRows(
    calls: {
      id?: string;
      sessionId: string;
      sendId: string;
      round: number;
      toolCallId: string;
      toolName: string;
      now: number;
    }[],
  ): Message[] {
    return calls.map((call) => {
      const id = call.id ?? newId();
      this.db
        .query(
          `insert into messages (id, session_id, seq, kind, send_id, round, tool_call_id, tool_name, status, created_at)
           values (?, ?, ?, 'tool', ?, ?, ?, ?, 'streaming', ?)`,
        )
        .run(
          id,
          call.sessionId,
          this.nextSeq(call.sessionId),
          call.sendId,
          call.round,
          call.toolCallId,
          call.toolName,
          call.now,
        );
      return this.message(id)!;
    });
  }

  // a tool row ends: the result text the model gets and its status,
  // guarded by status = 'streaming', so a late tool after a terminal
  // cleanup writes nothing. The updated row, or null when the guard
  // caught it
  finishTool(
    id: string,
    fields: {
      content: string;
      status: Exclude<MessageStatus, "streaming">;
      error: string | null;
      finishedAt: number;
    },
  ): Message | null {
    const changed =
      this.db
        .query(
          "update messages set content = ?, status = ?, error = ?, finished_at = ? where id = ? and kind = 'tool' and status = 'streaming'",
        )
        .run(fields.content, fields.status, fields.error, fields.finishedAt, id)
        .changes > 0;
    return changed ? this.message(id) : null;
  }

  createSend(fields: {
    id?: string;
    sessionId: string;
    userId: string;
    agentId: string;
    providerId: string;
    model: string;
    firstMessageId: string;
    now: number;
  }): SendSummary {
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into sends (id, session_id, kind, user_id, agent_id, provider_id, model,
           status, first_message_id, started_at)
         values (?, ?, 'chat', ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        id,
        fields.sessionId,
        fields.userId,
        fields.agentId,
        fields.providerId,
        fields.model,
        fields.firstMessageId,
        fields.now,
      );
    return this.send(id)!;
  }

  send(id: string): SendSummary | null {
    const raw = this.db
      .query<RawSend, [string]>("select * from sends where id = ?")
      .get(id);
    return raw ? send(raw) : null;
  }

  lastSend(sessionId: string): SendSummary | null {
    const raw = this.db
      .query<RawSend, [string]>(
        "select * from sends where session_id = ? order by started_at desc, id desc limit 1",
      )
      .get(sessionId);
    return raw ? send(raw) : null;
  }

  finishSend(
    id: string,
    fields: {
      status: Exclude<SessionStatus, "running">;
      cause: SendCause;
      error: string | null;
      // the send's final counters: provider rounds and calls launched
      rounds: number;
      toolCalls: number;
      finishedAt: number;
    },
  ): SendSummary | null {
    this.db
      .query(
        "update sends set status = ?, cause = ?, error = ?, rounds = ?, tool_calls = ?, finished_at = ? where id = ? and status = 'running'",
      )
      .run(
        fields.status,
        fields.cause,
        fields.error,
        fields.rounds,
        fields.toolCalls,
        fields.finishedAt,
        id,
      );
    return this.send(id);
  }

  // the running counters as the loop advances, without ending the send:
  // startRound bumps rounds, a round's launched calls bump tool_calls
  bumpCounters(
    id: string,
    fields: { rounds: number; toolCalls: number },
  ): SendSummary | null {
    this.db
      .query(
        "update sends set rounds = ?, tool_calls = ? where id = ? and status = 'running'",
      )
      .run(fields.rounds, fields.toolCalls, id);
    return this.send(id);
  }

  // Repair every session named by a running session/send or streaming
  // message. Inconsistent crash rows still need a revision and envelope,
  // rather than being changed globally without notifying their session.
  repair(now: number, error: string): RepairedSession[] {
    const ids = this.db
      .query<{ id: string }, []>(
        `select id from sessions where status = 'running'
         union select session_id from sends where status = 'running'
         union select session_id from messages where status = 'streaming'`,
      )
      .all()
      .map((r) => r.id);
    if (ids.length === 0) return [];
    // the reply rows about to end need a slot; a null one becomes an
    // answer before its status moves, so the not-streaming check holds
    this.db
      .query(
        "update messages set slot = 'answer' where kind = 'reply' and status = 'streaming' and slot is null",
      )
      .run();
    // the ids of the rows this repair will end, before they change, so
    // the envelope can read them back
    const changedByStatus = this.db
      .query<{ id: string; session_id: string }, []>(
        "select id, session_id from messages where status = 'streaming'",
      )
      .all();
    this.db
      .query(
        "update sends set status = 'failed', cause = 'restart', error = ?, finished_at = ? where status = 'running'",
      )
      .run(error, now);
    this.db
      .query(
        "update messages set status = 'stopped', error = ?, finished_at = ? where kind = 'tool' and status = 'streaming'",
      )
      .run(error, now);
    this.db
      .query(
        "update messages set status = 'failed', error = ?, finished_at = ? where status = 'streaming'",
      )
      .run(error, now);
    return ids.map((id) => {
      const session = this.touch(id, { status: "failed", now })!;
      const messages = changedByStatus
        .filter((row) => row.session_id === id)
        .map((row) => this.message(row.id)!);
      return { session, messages, send: this.lastSend(id) };
    });
  }

  private nextSeq(sessionId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select coalesce(max(seq), 0) + 1 as n from messages where session_id = ?",
      )
      .get(sessionId)!.n;
  }
}
