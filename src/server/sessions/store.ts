// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
import type { AutomationRunsResponse } from "../../shared/api/automations.ts";
import type { SessionsResponse } from "../../shared/api/sessions.ts";
import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type { MessageUpload } from "../../shared/uploads.ts";
import type { MessageStatus, SessionStatus } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { OpenedRecord } from "../knowledge/index.ts";
import { newId } from "../lib/ids.ts";
import type { ReasoningDetail } from "../providers/index.ts";
import {
  automationRunning,
  automationRuns,
  expiredAutomationRuns,
  type RunsArgs,
} from "./automation.ts";
import { forgetCapability as forget, setDisabled } from "./capabilities.ts";
import { exportRows, authors as readAuthors } from "./export.ts";
import {
  copyRows,
  type ForkFields,
  forkedFrom as readForkedFrom,
  readForkPoint,
} from "./fork.ts";
import { type ListArgs, listSessions } from "./list.ts";
import type { ExportRow } from "./markdown.ts";
import {
  insertMcpSend,
  type McpSendFields,
  lastMcpDigest as readLastMcpDigest,
  sweepMcpDigests,
} from "./mcp.ts";
import {
  type MemorySnapshot,
  memorySnapshot as readMemorySnapshot,
} from "./memory.ts";
import { addAgentMessage, finishReply } from "./messages.ts";
import { readOpenedFile, writeOpenedFiles } from "./opened-store.ts";
import { titleFrom } from "./parse.ts";
import { replaceSendRows } from "./regenerate.ts";
import { repairRows } from "./repair.ts";
import {
  type CreateSession,
  MESSAGE_COLUMNS,
  message,
  type RawMessage,
  type RawSession,
  type RepairedSession,
  type ReplyFinish,
  type SessionRow,
  session,
  type UsagePort,
} from "./rows.ts";
import {
  bumpSendCounters,
  endSendRow,
  readLastSend,
  readReasoningDetails,
  readSend,
  type SendCounters,
  type SendEnd,
  usesAgent,
} from "./sends.ts";

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

  list(...args: ListArgs): SessionsResponse {
    return listSessions(this.db, this.usage, ...args);
  }

  runs(...args: RunsArgs): AutomationRunsResponse {
    return automationRuns(this.db, this.usage, ...args);
  }

  create(fields: CreateSession): SessionRow {
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into sessions (id, project_id, owner_id, agent_id, origin,
           automation_id, run_source, title, status, revision, created_at,
           last_activity_at, forked_from_session_id, forked_from_message_id,
           disabled_capabilities)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
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
        fields.status ?? "running",
        fields.now,
        fields.now,
        fields.forkedFromSessionId ?? null,
        fields.forkedFromMessageId ?? null,
        JSON.stringify(fields.disabledCapabilities ?? []),
      );
    return this.byId(id)!;
  }

  fork(fields: ForkFields): {
    session: SessionRow;
    messages: Message[];
    messageIds: ReadonlyMap<string, string>;
    draft: string | null;
  } {
    const { source, messageId } = fields;
    const point = readForkPoint(this.db, source.id, messageId);
    const session = this.create({
      projectId: source.projectId,
      title: fields.title ?? titleFrom(`Fork of ${source.title}`),
      ownerId: fields.ownerId,
      agentId: fields.agentId,
      now: fields.now,
      status: "done",
      forkedFromSessionId: source.id,
      forkedFromMessageId: messageId,
      disabledCapabilities: source.disabledCapabilities,
    });
    const messageIds = copyRows(this.db, {
      sessionId: session.id,
      rows: point.rows,
      now: fields.now,
    });
    return {
      session,
      messages: this.messages(session.id),
      messageIds,
      draft: point.draft,
    };
  }

  forkedFrom(id: string) {
    return readForkedFrom(this.db, id);
  }

  authors(id: string) {
    return readAuthors(this.db, id);
  }

  setDisabledCapabilities(id: string, set: readonly string[]): void {
    setDisabled(this.db, id, set);
  }

  forgetCapability(key: string): void {
    forget(this.db, key);
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
    return usesAgent(this.db, agentId);
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
    return exportRows(this.db, sessionId);
  }

  memorySnapshot(
    projectId: string,
    id: string,
    isWrite: (name: string) => boolean,
  ): MemorySnapshot | null {
    return readMemorySnapshot(projectId, id, this, isWrite);
  }

  message(id: string): Message | null {
    const raw = this.db
      .query<RawMessage, [string]>(
        `select ${MESSAGE_COLUMNS} from messages where id = ?`,
      )
      .get(id);
    return raw ? message(raw) : null;
  }

  openedFile(messageId: string, index: number) {
    return readOpenedFile(this.db, messageId, index);
  }

  reasoningDetails(
    id: string,
    providerId: string,
    model: string,
  ): ReasoningDetail[] | null {
    return readReasoningDetails(this.db, id, providerId, model);
  }

  addUserMessage(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    userId: string;
    content: string;
    uploads?: MessageUpload[] | null;
    now: number;
  }): Message {
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into messages (id, session_id, seq, kind, send_id, round,
           user_id, content, uploads, status, created_at, finished_at)
         values (?, ?, ?, 'user', ?, 1, ?, ?, ?, 'done', ?, ?)`,
      )
      .run(
        id,
        fields.sessionId,
        this.nextSeq(fields.sessionId),
        fields.sendId,
        fields.userId,
        fields.content,
        fields.uploads?.length ? JSON.stringify(fields.uploads) : null,
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
    return finishReply(this.db, id, fields) ? this.message(id) : null;
  }

  capWork(id: string, finishReason: string): Message | null {
    const changed =
      this.db
        .query(
          "update messages set finish_reason = ? where id = ? and kind = 'reply' and slot = 'work' and status = 'done'",
        )
        .run(finishReason, id).changes > 0;
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
      opened?: OpenedRecord[] | null;
    },
  ): Message | null {
    const changed =
      this.db
        .query(
          "update messages set content = ?, status = ?, error = ?, finished_at = ? where id = ? and kind = 'tool' and status = 'streaming'",
        )
        .run(fields.content, fields.status, fields.error, fields.finishedAt, id)
        .changes > 0;
    if (changed && fields.opened?.length) {
      writeOpenedFiles(this.db, id, fields.opened);
    }
    return changed ? this.message(id) : null;
  }

  createSend(fields: McpSendFields): SendSummary {
    return this.send(insertMcpSend(this.db, fields))!;
  }

  lastMcpDigest(sessionId: string, excludeSendId: string): McpDigest | null {
    return readLastMcpDigest(this.db, sessionId, excludeSendId);
  }

  sweepDigests(): number {
    return sweepMcpDigests(this.db);
  }

  send(id: string): SendSummary | null {
    return readSend(this.db, id);
  }

  lastSend(sessionId: string): SendSummary | null {
    return readLastSend(this.db, sessionId);
  }

  finishSend(id: string, fields: SendEnd): SendSummary | null {
    return endSendRow(this.db, id, fields);
  }

  bumpCounters(id: string, fields: SendCounters): SendSummary | null {
    return bumpSendCounters(this.db, id, fields);
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
