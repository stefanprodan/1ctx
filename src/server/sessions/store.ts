// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
import type { AutomationRunsResponse } from "../../shared/api/automations.ts";
import type { SessionsResponse } from "../../shared/api/sessions.ts";
import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type { ArchiveReason, SessionStatus } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import type { ReasoningDetail } from "../providers/index.ts";
import { archiveRow } from "./archive.ts";
import {
  automationRunning,
  automationRuns,
  expiredAutomationRuns,
  type RunsQuery,
} from "./automation.ts";
import { forgetCapabilityIn, setDisabled } from "./capabilities.ts";
import { descendants, ROOT } from "./children.ts";
import { type Pruned, removeSession, type SessionDeleted } from "./delete.ts";
import {
  agents as readAgents,
  archive as readArchive,
  authors as readAuthors,
} from "./detail.ts";
import { exportRows } from "./export.ts";
import {
  copyRows,
  type ForkFields,
  forkedFrom as readForkedFrom,
  readForkPoint,
} from "./fork.ts";
import { type ListQuery, listSessions } from "./list.ts";
import type { ExportRow } from "./markdown.ts";
import { markRun, type RunMark } from "./marks.ts";
import {
  type DigestArgs,
  lastMcpDigest as readLastMcpDigest,
  sweepMcpDigests,
} from "./mcp.ts";
import {
  type AgentMessageFields,
  addAgentMessage,
  addToolRows,
  addUserMessage,
  capWork,
  finishReply,
  finishToolRow,
  type MountedRepos,
  markRoundWork,
  markSlot,
  mountedBefore,
  readMessage,
  readMessages,
  readMountedRepos,
  setMountedRepos,
  type ToolFinish,
  writeReply,
} from "./messages.ts";
import { readOpenedFile } from "./opened-store.ts";
import { packRows, resultText } from "./pack.ts";
import { titleFrom } from "./parse.ts";
import { QueueStore } from "./queued.ts";
import { replaceSendRows } from "./regenerate.ts";
import { repairRows } from "./repair.ts";
import {
  type CreateSession,
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
  insertSend,
  readLastSend,
  readReasoningDetails,
  readSend,
  type SendCounters,
  type SendEnd,
  type SendFields,
} from "./sends.ts";

// the bash area's scratch of a chat, dropped when it is archived,
// and the sessions a command holds now
export type ScratchPort = {
  drop(sessionId: string): void;
  held(): ReadonlySet<string>;
};

export class SessionStore {
  // the messages waiting behind a busy chat
  readonly queue: QueueStore;
  constructor(
    private readonly db: Db,
    private readonly usage: UsagePort,
    private readonly scratch: ScratchPort,
    private readonly pruned: Pruned = () => [],
  ) {
    this.queue = new QueueStore(db);
  }

  byId(id: string): SessionRow | null {
    const raw = this.db
      .query<RawSession, [string]>("select * from sessions where id = ?")
      .get(id);
    return raw ? session(raw, this.usage.latest(raw.id)) : null;
  }

  // the session when it is a root, null when gone or a subagent's child,
  // which no route or watch may reach
  root(id: string): SessionRow | null {
    const raw = this.db
      .query<RawSession, [string]>(
        `select * from sessions where id = ? and ${ROOT}`,
      )
      .get(id);
    return raw ? session(raw, this.usage.latest(raw.id)) : null;
  }

  // the child sessions under a root, which go wherever it goes
  children(id: string): string[] {
    return descendants(this.db, id);
  }

  list(query: ListQuery): SessionsResponse {
    return listSessions(this.db, this.usage, query);
  }

  runs(query: RunsQuery): AutomationRunsResponse {
    return automationRuns(this.db, this.usage, query);
  }

  // a child belongs to its root's automation through the root alone, so
  // a run's picks and its task's retention only ever meet roots
  create(fields: CreateSession): SessionRow {
    if (fields.parent && fields.automationId) {
      throw new Error("a child session has no automation");
    }
    const id = fields.id ?? newId();
    this.db
      .query(
        `insert into sessions (id, project_id, owner_id, agent_id, origin,
           automation_id, run_source, title, status, revision, created_at,
           last_activity_at, forked_from_session_id, forked_from_message_id,
           disabled_capabilities, parent_session_id, parent_message_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
        fields.parent?.sessionId ?? null,
        fields.parent?.messageId ?? null,
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
    const children = this.children(id);
    for (const child of children) archiveRow(this.db, child, reason, by, now);
    if (reason !== "agent") {
      const held = this.scratch.held();
      for (const one of [id, ...children]) {
        if (!held.has(one)) this.scratch.drop(one);
        packRows(this.db, one);
      }
    }
    return this.byId(id);
  }

  // the session's large tool results compressed, its children's with
  // them; never one that runs
  pack(id: string): number {
    return [id, ...this.children(id)].reduce(
      (n, one) => n + packRows(this.db, one),
      0,
    );
  }

  // a tool row's whole text, packed or not
  result(messageId: string): string | null {
    return resultText(this.db, messageId);
  }

  setDisabledCapabilities(id: string, set: readonly string[]): void {
    setDisabled(this.db, id, set);
  }

  forgetCapability(key: string, projectId?: string): void {
    forgetCapabilityIn(this.db, "sessions", key, projectId);
  }

  // the commits a turn mounted, on its first message
  setMountedRepos(messageId: string, mounted: MountedRepos): void {
    setMountedRepos(this.db, messageId, mounted);
  }

  mountedRepos(messageId: string): MountedRepos | null {
    return readMountedRepos(this.db, messageId);
  }

  // what the chat's turns before this send mounted, newest first
  mountedBefore(sessionId: string, sendId: string): MountedRepos[] {
    return mountedBefore(this.db, sessionId, sendId);
  }

  // a run's end may carry its mark, written in the same transaction
  touch(
    id: string,
    fields: { status: SessionStatus; now: number; mark?: RunMark | null },
  ): SessionRow | null {
    if (fields.mark) markRun(this.db, id, fields.mark);
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
    return removeSession(this.db, id, this.pruned);
  }

  count(projectId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        `select count(*) as n from sessions where project_id = ? and ${ROOT}`,
      )
      .get(projectId)!.n;
  }

  running(projectId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          `select count(*) as n from sessions
           where project_id = ? and status = 'running' and ${ROOT}`,
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
    return readMessages(this.db, sessionId);
  }

  exportRows(sessionId: string): ExportRow[] {
    return exportRows(this.db, sessionId);
  }

  message(id: string): Message | null {
    return readMessage(this.db, id);
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

  addUserMessage(fields: Parameters<typeof addUserMessage>[1]): Message {
    return addUserMessage(this.db, fields);
  }

  replaceSend(users: readonly Message[], newSendId: string) {
    return replaceSendRows(this.db, users, newSendId);
  }

  addReply(fields: AgentMessageFields): Message {
    return addAgentMessage(this.db, "reply", fields);
  }

  addSummary(fields: AgentMessageFields): Message {
    return addAgentMessage(this.db, "summary", fields);
  }

  writeReply(id: string, fields: Parameters<typeof writeReply>[2]): boolean {
    return writeReply(this.db, id, fields);
  }

  finishReply(id: string, fields: ReplyFinish): Message | null {
    return finishReply(this.db, id, fields) ? this.message(id) : null;
  }

  capWork(id: string, finishReason: string): Message | null {
    return capWork(this.db, id, finishReason) ? this.message(id) : null;
  }

  // guarded by the null slot, so a second call delta writes nothing
  markRoundWork(id: string): Message | null {
    return markRoundWork(this.db, id) ? this.message(id) : null;
  }

  // the repair places a reply before it ends it
  markSlot(id: string, slot: "work" | "answer"): Message | null {
    return markSlot(this.db, id, slot) ? this.message(id) : null;
  }

  addToolRows(calls: Parameters<typeof addToolRows>[1]): Message[] {
    return addToolRows(this.db, calls);
  }

  finishTool(id: string, fields: ToolFinish): Message | null {
    return finishToolRow(this.db, id, fields) ? this.message(id) : null;
  }

  createSend(fields: SendFields): SendSummary {
    return this.send(insertSend(this.db, fields))!;
  }

  lastMcpDigest(...args: DigestArgs): McpDigest | null {
    return readLastMcpDigest(this.db, ...args);
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
