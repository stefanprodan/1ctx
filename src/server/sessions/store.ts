// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The session, message and send rows. Every write that changes what a
// session is goes with a touch() that bumps the revision; a checkpoint
// of a reply in flight does not, since it is for a crash, not a reader.

import type {
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type {
  MessageKind,
  MessageStatus,
  SendCause,
  SessionStatus,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import type { ReasoningDetail } from "../providers/index.ts";

export type SessionRow = SessionSummary;

export const STREAM_LIMIT = 100;

type RawSession = {
  id: string;
  project_id: string;
  owner_id: string;
  agent_id: string;
  origin: "chat";
  title: string;
  status: SessionStatus;
  revision: number;
  created_at: number;
  last_activity_at: number;
};

const session = (raw: RawSession): SessionRow => ({
  id: raw.id,
  projectId: raw.project_id,
  ownerId: raw.owner_id,
  agentId: raw.agent_id,
  origin: raw.origin,
  title: raw.title,
  status: raw.status,
  revision: raw.revision,
  createdAt: raw.created_at,
  lastActivityAt: raw.last_activity_at,
});

type RawMessage = {
  id: string;
  session_id: string;
  seq: number;
  kind: MessageKind;
  user_id: string | null;
  agent_id: string | null;
  content: string;
  reasoning: string;
  html: string;
  status: MessageStatus;
  error: string | null;
  finish_reason: string | null;
  model: string | null;
  ttft_ms: number | null;
  thinking_ms: number | null;
  created_at: number;
  finished_at: number | null;
};

const MESSAGE_COLUMNS =
  "id, session_id, seq, kind, user_id, agent_id, content, reasoning, html, status, error, finish_reason, model, ttft_ms, thinking_ms, created_at, finished_at";

const message = (raw: RawMessage): Message => ({
  id: raw.id,
  sessionId: raw.session_id,
  seq: raw.seq,
  kind: raw.kind,
  userId: raw.user_id,
  agentId: raw.agent_id,
  content: raw.content,
  reasoning: raw.reasoning,
  html: raw.html,
  status: raw.status,
  error: raw.error,
  finishReason: raw.finish_reason,
  model: raw.model,
  ttftMs: raw.ttft_ms,
  thinkingMs: raw.thinking_ms,
  createdAt: raw.created_at,
  finishedAt: raw.finished_at,
});

type RawSend = {
  id: string;
  session_id: string;
  kind: "chat";
  user_id: string;
  agent_id: string;
  provider_id: string;
  model: string;
  status: SessionStatus;
  cause: SendCause | null;
  error: string | null;
  first_message_id: string;
  started_at: number;
  finished_at: number | null;
};

const send = (raw: RawSend): SendSummary => ({
  id: raw.id,
  sessionId: raw.session_id,
  kind: raw.kind,
  userId: raw.user_id,
  agentId: raw.agent_id,
  providerId: raw.provider_id,
  model: raw.model,
  status: raw.status,
  cause: raw.cause,
  error: raw.error,
  firstMessageId: raw.first_message_id,
  startedAt: raw.started_at,
  finishedAt: raw.finished_at,
});

export type ReplyFinish = {
  content: string;
  reasoning: string;
  reasoningDetails: ReasoningDetail[];
  html: string;
  status: Exclude<MessageStatus, "streaming">;
  error: string | null;
  finishReason: string | null;
  ttftMs: number | null;
  thinkingMs: number | null;
  finishedAt: number;
};

export class SessionStore {
  constructor(private readonly db: Db) {}

  byId(id: string): SessionRow | null {
    const raw = this.db
      .query<RawSession, [string]>("select * from sessions where id = ?")
      .get(id);
    return raw ? session(raw) : null;
  }

  // the stream: the sessions of the given projects, running first, then
  // by last activity, the title searched when there is a query
  list(projectIds: string[], q: string, limit = STREAM_LIMIT): SessionRow[] {
    if (projectIds.length === 0) return [];
    const marks = projectIds.map(() => "?").join(", ");
    const needle = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    return this.db
      .query<RawSession, (string | number)[]>(
        `select * from sessions
         where project_id in (${marks})
           and (? = '' or title like ? escape '\\')
         order by status = 'running' desc, last_activity_at desc, id
         limit ?`,
      )
      .all(...projectIds, q, needle, limit)
      .map(session);
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

  addUserMessage(fields: {
    sessionId: string;
    userId: string;
    content: string;
    now: number;
  }): Message {
    const id = newId();
    this.db
      .query(
        `insert into messages (id, session_id, seq, kind, user_id, content, status, created_at, finished_at)
         values (?, ?, ?, 'user', ?, ?, 'done', ?, ?)`,
      )
      .run(
        id,
        fields.sessionId,
        this.nextSeq(fields.sessionId),
        fields.userId,
        fields.content,
        fields.now,
        fields.now,
      );
    return this.message(id)!;
  }

  addReply(fields: {
    sessionId: string;
    agentId: string;
    model: string;
    now: number;
  }): Message {
    const id = newId();
    this.db
      .query(
        `insert into messages (id, session_id, seq, kind, agent_id, model, status, created_at)
         values (?, ?, ?, 'reply', ?, ?, 'streaming', ?)`,
      )
      .run(
        id,
        fields.sessionId,
        this.nextSeq(fields.sessionId),
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
    this.db
      .query(
        `update messages set content = ?, reasoning = ?, reasoning_details = ?, html = ?,
           status = ?, error = ?, finish_reason = ?, ttft_ms = ?, thinking_ms = ?,
           finished_at = ?
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
        fields.ttftMs,
        fields.thinkingMs,
        fields.finishedAt,
        id,
      );
    return this.message(id);
  }

  createSend(fields: {
    sessionId: string;
    userId: string;
    agentId: string;
    providerId: string;
    model: string;
    firstMessageId: string;
    now: number;
  }): SendSummary {
    const id = newId();
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
      finishedAt: number;
    },
  ): SendSummary | null {
    this.db
      .query(
        "update sends set status = ?, cause = ?, error = ?, finished_at = ? where id = ? and status = 'running'",
      )
      .run(fields.status, fields.cause, fields.error, fields.finishedAt, id);
    return this.send(id);
  }

  // the rows a crash left running: every send, reply and session still
  // marked so, ended as failed with the one error, in the caller's
  // transaction; the sessions touched
  repair(now: number, error: string): SessionRow[] {
    const ids = this.db
      .query<{ id: string }, []>(
        "select id from sessions where status = 'running'",
      )
      .all()
      .map((r) => r.id);
    this.db
      .query(
        "update sends set status = 'failed', cause = 'restart', error = ?, finished_at = ? where status = 'running'",
      )
      .run(error, now);
    this.db
      .query(
        "update messages set status = 'failed', error = ?, finished_at = ? where status = 'streaming'",
      )
      .run(error, now);
    return ids.map((id) => this.touch(id, { status: "failed", now })!);
  }

  private nextSeq(sessionId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select coalesce(max(seq), 0) + 1 as n from messages where session_id = ?",
      )
      .get(sessionId)!.n;
  }
}
