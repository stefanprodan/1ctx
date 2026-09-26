// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
import type { AutomationRunsResponse } from "../../shared/api/automations.ts";
import type { SessionsResponse } from "../../shared/api/sessions.ts";
import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type { MessageUpload } from "../../shared/uploads.ts";
import type {
  ArchiveReason,
  MessageStatus,
  SessionStatus,
} from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { OpenedRecord } from "../knowledge/index.ts";
import { newId } from "../lib/ids.ts";
import type { ReasoningDetail } from "../providers/index.ts";
import { archiveRow } from "./archive.ts";
import {
  automationRunning,
  automationRuns,
  expiredAutomationRuns,
  type RunsArgs,
} from "./automation.ts";
import { forgetCapability as forget, setDisabled } from "./capabilities.ts";
import { deleteSession, type SessionDeleted } from "./delete.ts";
import {
  exportRows,
  agents as readAgents,
  archive as readArchive,
  authors as readAuthors,
} from "./export.ts";
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
  addAgentMessage,
  addToolRows,
  finishReply,
  nextSeq,
} from "./messages.ts";
import { readOpenedFile, writeOpenedFiles } from "./opened-store.ts";
import { packRows, resultText } from "./pack.ts";
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
} from "./sends.ts";

// the knowledge area's scratch of a chat, dropped when it is archived,
// and the sessions a command holds now
export type ScratchPort = {
  drop(sessionId: string): void;
  held(): ReadonlySet<string>;
};

export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly usage: UsagePort,
    private readonly scratch: ScratchPort,
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

  agents(id: string) {
    return readAgents(this.db, id);
  }

  archiveOf(id: string, keptDays: number) {
    return readArchive(this.db, id, keptDays);
  }

  // null when it was archived already. An agent's delete archives chats
  // that may still run and a held scratch has a command in it, so the
  // sweep frees and packs those once they end
  archive(
    id: string,
    reason: ArchiveReason,
    by: string | null,
    now: number,
  ): SessionRow | null {
    if (!archiveRow(this.db, id, reason, by, now)) return null;
    if (reason !== "agent" && !this.scratch.held().has(id)) {
      this.scratch.drop(id);
    }
    if (reason !== "agent") packRows(this.db, id);
    return this.byId(id);
  }

  // the session's large tool results compressed; never one that runs
  pack(id: string): number {
    return packRows(this.db, id);
  }

  // a tool row's whole text, packed or not
  result(messageId: string): string | null {
    return resultText(this.db, messageId);
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

  remove(id: string): SessionDeleted | "running" | null {
    return deleteSession(this.db, id);
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

  // every run of the automation in the caller's transaction, in one
  // statement however many runs it kept; their usage stays
  deleteRuns(automationId: string): number {
    return this.db
      .query("delete from sessions where automation_id = ?")
      .run(automationId).changes;
  }

  expiredRuns(now: number): SessionRow[] {
    return expiredAutomationRuns(this.db, this.usage, now);
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
        nextSeq(this.db, fields.sessionId),
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

  addToolRows(calls: Parameters<typeof addToolRows>[1]): Message[] {
    return addToolRows(this.db, calls);
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
}
