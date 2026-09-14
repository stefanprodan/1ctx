// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AutomationRunsResponse } from "../../shared/api/automations.ts";
import type { StreamRow } from "../../shared/api/sessions.ts";
import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type {
  MessageStatus,
  RunFilter,
  SendCause,
  SendKind,
  SessionStatus,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import type { ReasoningDetail } from "../providers/index.ts";
import {
  automationRunning,
  automationRuns,
  expiredAutomationRuns,
} from "./automation.ts";
import { listSessions } from "./list.ts";
import type { ExportRow } from "./markdown.ts";
import { addAgentMessage } from "./messages.ts";
import { replaceSendRows } from "./regenerate.ts";
import { repairRows } from "./repair.ts";
import {
  type CreateSession,
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

  list(
    projectIds: string[],
    q: string,
    origin: "chat" | "automation" | null = null,
    limit = STREAM_LIMIT,
  ): StreamRow[] {
    return listSessions(this.db, this.usage, projectIds, q, origin, limit);
  }

  runs(
    automationId: string,
    filter: RunFilter | null = null,
    limit = STREAM_LIMIT,
  ): AutomationRunsResponse {
    return automationRuns(this.db, this.usage, automationId, filter, limit);
  }

  create(fields: CreateSession): SessionRow {
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into sessions (id, project_id, owner_id, agent_id, origin,
           automation_id, run_source, title, status, revision, created_at,
           last_activity_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)`,
      )
      .run(
        id,
        fields.projectId,
        fields.ownerId,
        fields.agentId,
        fields.origin ?? "chat",
        fields.automationId ?? null,
        fields.runSource ?? null,
        fields.title,
        fields.now,
        fields.now,
      );
    return this.byId(id)!;
  }

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

  rename(id: string, title: string): SessionRow | null {
    this.db
      .query(
        "update sessions set title = ?, revision = revision + 1 where id = ?",
      )
      .run(title, id);
    return this.byId(id);
  }

  delete(id: string): boolean {
    return (
      this.db.query("delete from sessions where id = ?").run(id).changes > 0
    );
  }

  count(projectId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from sessions where project_id = ?",
      )
      .get(projectId)!.n;
  }

  running(projectId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from sessions where project_id = ? and status = 'running'",
        )
        .get(projectId)!.n > 0
    );
  }

  runningAutomation(automationId: string): boolean {
    return automationRunning(this.db, automationId);
  }

  expiredRuns(now: number): SessionRow[] {
    return expiredAutomationRuns(this.db, this.usage, now);
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

  exportRows(sessionId: string): ExportRow[] {
    return this.db
      .query<ExportRow, [string]>(
        `select messages.send_id as sendId, messages.kind, messages.slot,
           messages.status, messages.error,
           messages.finish_reason as finishReason,
           coalesce(users.username, agents.name) as author,
           case when messages.kind = 'user'
               or (messages.kind = 'reply' and messages.slot = 'answer')
             then messages.content else '' end as content,
           messages.created_at as createdAt,
           messages.finished_at as finishedAt
         from messages
         left join users on users.id = messages.user_id
         left join agents on agents.id = messages.agent_id
         where messages.session_id = ?
         order by messages.seq`,
      )
      .all(sessionId);
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

  replaceSend(user: Message, newSendId: string) {
    return replaceSendRows(this.db, user, newSendId);
  }
  addReply(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    round: number;
    agentId: string;
    model: string;
    now: number;
  }): Message {
    return addAgentMessage(this.db, "reply", fields);
  }

  addSummary(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    round: number;
    agentId: string;
    model: string;
    now: number;
  }): Message {
    return addAgentMessage(this.db, "summary", fields);
  }

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

  // guarded by the null slot, so a second call delta writes nothing
  markRoundWork(id: string): Message | null {
    const sql =
      "update messages set slot = 'work' where id = ? and kind = 'reply' and status = 'streaming' and slot is null";
    const changed = this.db.query(sql).run(id).changes > 0;
    return changed ? this.message(id) : null;
  }

  // the repair places a reply before it ends it
  markSlot(id: string, slot: "work" | "answer"): Message | null {
    const changed =
      this.db
        .query(
          "update messages set slot = ? where id = ? and kind = 'reply' and slot is null",
        )
        .run(slot, id).changes > 0;
    return changed ? this.message(id) : null;
  }

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

  // guarded by status, so a tool that ends after a terminal cleanup
  // writes nothing
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
    kind?: SendKind;
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
         values (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        id,
        fields.sessionId,
        fields.kind ?? "chat",
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
        "select * from sends where session_id = ? order by started_at desc, rowid desc limit 1",
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

  // the rows are read back through this store so the envelope carries
  // them
  repair(now: number, error: string): RepairedSession[] {
    return repairRows(this.db, now, error, {
      touch: (id) => this.touch(id, { status: "failed", now })!,
      message: (id) => this.message(id)!,
      lastSend: (id) => this.lastSend(id),
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
