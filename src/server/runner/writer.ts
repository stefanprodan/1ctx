// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Persistence and the socket frames of a send. Each durable change is
// one transact() over the db: one touch() that bumps the revision once,
// and one envelope after commit carrying exactly the rows it changed.
// startSend opens the send; delta streams the reply in flight without a
// revision, checkpointed every 250 ms or 2 KB; markRoundWork moves a
// reply into the fold at the first tool call; finishRound ends a work
// round and launches its tool rows; finishTool ends one tool; recordUnrun
// writes a round's calls as not run when a cap or the loop cut them;
// startRound begins the next round; finalizeSend ends the send once.

import type {
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { SendCause, SessionStatus } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import type { ChatEvent, Usage } from "../providers/index.ts";
import type { SessionRow } from "../sessions/index.ts";
import type { UsageFields } from "../usage/index.ts";
import type { SendPolicy, ToolResult } from "./policy.ts";
import type { ActiveSend, RoundState } from "./send.ts";
import { streamDelta } from "./stream.ts";
import type { SessionsPort } from "./writer-port.ts";

export { HTML_EVERY_MS, WRITE_EVERY_BYTES, WRITE_EVERY_MS } from "./stream.ts";
export type { SessionsPort } from "./writer-port.ts";

// the text a call cut before it ran gets, as its content
export const NOT_RUN = "not run: the tool budget was spent";
// the text a call still running when the send ended gets
export const CUT_SHORT = "stopped before it finished";

export type WriterDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  usage: {
    record(fields: UsageFields): unknown;
    deleteSend(sendId: string): boolean;
  };
  render: (markdown: string, streaming: boolean) => string;
  // the stream frames, straight to the watchers
  stream: (sessionId: string, frame: SocketEvent) => void;
};

export type Started = {
  session: SessionSummary;
  user: Message;
  reply: Message;
  send: SendSummary;
};

// the status a cause ends in
export function statusOf(cause: SendCause): Exclude<SessionStatus, "running"> {
  switch (cause) {
    case "finish":
      return "done";
    case "stop":
    case "shutdown":
      return "stopped";
    default:
      return "failed";
  }
}

const envelope = (
  session: SessionSummary,
  messages: Message[],
  send: SendSummary | null,
  removedMessageIds: string[] = [],
): BusEvent => ({
  type: "session.changed",
  data: {
    projectId: session.projectId,
    session,
    messages,
    ...(removedMessageIds.length > 0 ? { removedMessageIds } : {}),
    send,
  },
});

export class Writer {
  constructor(private readonly deps: WriterDeps) {}

  // with the lock already held: the send row, its user row, the reply
  // that streams, and the running state. Regeneration reuses its user
  // row while the same transaction removes the send it replaces.
  startSend(fields: {
    sendId: string;
    replyId: string;
    userId: string;
    sessionId: string;
    session: SessionRow | null;
    existingUser?: Message;
    title: string;
    policy: SendPolicy;
    text: string;
  }): Started {
    const { policy } = fields;
    const now = this.deps.clock();
    return transact(this.deps.db, () => {
      const base =
        fields.session ??
        this.deps.sessions.create({
          id: fields.sessionId,
          projectId: policy.projectId,
          ownerId: policy.userId,
          agentId: policy.agentId,
          title: fields.title,
          now,
        });
      const send = this.deps.sessions.createSend({
        id: fields.sendId,
        sessionId: base.id,
        userId: policy.userId,
        agentId: policy.agentId,
        providerId: policy.providerId,
        model: policy.model,
        firstMessageId: fields.userId,
        now,
      });
      let removedMessageIds: string[] = [];
      let user: Message;
      if (fields.existingUser === undefined) {
        user = this.deps.sessions.addUserMessage({
          id: fields.userId,
          sessionId: base.id,
          sendId: send.id,
          userId: policy.userId,
          content: fields.text,
          now,
        });
      } else {
        const existing = fields.existingUser;
        this.deps.usage.deleteSend(existing.sendId);
        const replacement = this.deps.sessions.replaceSend(existing, send.id);
        user = replacement.user;
        removedMessageIds = replacement.removedMessageIds;
      }
      const reply = this.deps.sessions.addReply({
        id: fields.replyId,
        sessionId: base.id,
        sendId: send.id,
        round: 1,
        agentId: policy.agentId,
        model: policy.model,
        now,
      });
      const session = this.deps.sessions.touch(base.id, {
        status: "running",
        now,
      })!;
      return {
        result: { session, user, reply, send },
        events: [envelope(session, [user, reply], send, removedMessageIds)],
      };
    });
  }

  delta(
    send: ActiveSend,
    event: Extract<ChatEvent, { kind: "reasoning" | "content" }>,
  ): void {
    streamDelta(this.deps, send, event);
  }

  private session(id: string, now: number): SessionSummary {
    return this.deps.sessions.touch(id, { status: "running", now })!;
  }

  // the first tool call delta of a round: the streaming reply moves into
  // the fold, guarded by its null slot, one revision, one envelope
  markRoundWork(send: ActiveSend): void {
    const round = send.round;
    if (round === null) return;
    const now = this.deps.clock();
    transact(this.deps.db, () => {
      const reply = this.deps.sessions.markRoundWork(round.messageId);
      if (reply === null) return { result: undefined, events: [] };
      const session = this.session(send.sessionId, now);
      return {
        result: undefined,
        events: [envelope(session, [reply], null)],
      };
    });
  }

  private finishReplyRow(
    round: RoundState,
    status: Exclude<SessionStatus, "running">,
    error: string | null,
    slot: "work" | "answer",
    toolCalls: ToolCall[] | null,
    now: number,
    finishReason = round.finishReason,
  ): Message | null {
    const thinkingMs =
      round.thinkingMs ??
      (round.reasoningStartedAt === null
        ? null
        : now - round.reasoningStartedAt);
    return this.deps.sessions.finishReply(round.messageId, {
      content: round.content,
      reasoning: round.reasoning,
      reasoningDetails: round.reasoningDetails,
      html: this.deps.render(round.content, false),
      status,
      error,
      finishReason,
      slot,
      toolCalls,
      ttftMs: round.ttftMs,
      thinkingMs,
      finishedAt: now,
    });
  }

  private recordUsage(send: ActiveSend, round: RoundState, now: number): void {
    const usage: Usage | null = round.usage;
    if (usage === null) return;
    this.deps.usage.record({
      sendId: send.id,
      sessionId: send.sessionId,
      projectId: send.projectId,
      userId: send.policy.userId,
      agentId: send.policy.agentId,
      providerId: send.policy.providerId,
      model: send.policy.model,
      round: send.roundNo,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      cost: usage.cost,
      contextLength: send.policy.contextLength,
      now,
    });
  }

  private newToolRows(send: ActiveSend, calls: ToolCall[], now: number) {
    return this.deps.sessions.addToolRows(
      calls.map((call) => ({
        sessionId: send.sessionId,
        sendId: send.id,
        round: send.roundNo,
        toolCallId: call.id,
        toolName: call.name,
        now,
      })),
    );
  }

  // a work round that ends with calls to run: the reply done as work
  // with its calls, its usage, one streaming tool row per call, the
  // send's counters bumped. One revision, one envelope with every row.
  // The launched tool rows are tracked on the send, by call id, so the
  // loop's finishTool and a terminal cleanup find them
  finishRound(send: ActiveSend): { rows: Message[]; toolCalls: number } {
    const round = send.round;
    if (round === null) return { rows: [], toolCalls: 0 };
    const now = this.deps.clock();
    const launched = send.budget.calls + round.calls.length;
    const result = transact(this.deps.db, () => {
      const reply = this.finishReplyRow(
        round,
        "done",
        null,
        "work",
        round.calls,
        now,
      );
      this.recordUsage(send, round, now);
      const rows = this.newToolRows(send, round.calls, now);
      const sendRow = this.deps.sessions.bumpCounters(send.id, {
        rounds: send.roundNo,
        toolCalls: launched,
      });
      const session = this.session(send.sessionId, now);
      return {
        result: { rows, toolCalls: launched },
        events: [envelope(session, reply ? [reply, ...rows] : rows, sendRow)],
      };
    });
    send.openTools = new Map();
    round.calls.forEach((call, i) => {
      send.openTools.set(call, result.rows[i]!.id);
    });
    return result;
  }

  // one tool's end: an update guarded by status streaming, so a late
  // tool after a terminal cleanup writes nothing. One revision, one
  // envelope with the row it changed
  finishTool(send: ActiveSend, call: ToolCall, result: ToolResult): boolean {
    const rowId = send.openTools.get(call);
    if (rowId === undefined) return false;
    const now = this.deps.clock();
    const changed = transact(this.deps.db, () => {
      const row = this.deps.sessions.finishTool(rowId, {
        content: result.content,
        status: result.error ? "failed" : "done",
        error: result.error ? result.content : null,
        finishedAt: now,
      });
      if (row === null) return { result: false, events: [] };
      const session = this.session(send.sessionId, now);
      return { result: true, events: [envelope(session, [row], null)] };
    });
    if (changed) send.openTools.delete(call);
    return changed;
  }

  // a round the loop cut before its calls ran: the reply done as work
  // with the given finish reason, the calls written stopped with the
  // not-run text. One revision, one envelope with every row
  recordUnrun(send: ActiveSend, finishReason: string, calls: ToolCall[]): void {
    const round = send.round;
    if (round === null) return;
    const now = this.deps.clock();
    transact(this.deps.db, () => {
      const reply = this.finishReplyRow(
        round,
        "done",
        null,
        "work",
        calls,
        now,
        finishReason,
      );
      const created = this.newToolRows(send, calls, now);
      const stopped = created.map(
        (row) =>
          this.deps.sessions.finishTool(row.id, {
            content: NOT_RUN,
            status: "stopped",
            error: null,
            finishedAt: now,
          })!,
      );
      this.recordUsage(send, round, now);
      const session = this.session(send.sessionId, now);
      return {
        result: undefined,
        events: [
          envelope(session, reply ? [reply, ...stopped] : stopped, null),
        ],
      };
    });
  }

  // the next streaming reply and, on a cap transition, the work reply
  // and not-run calls that led to it. The round number and counters bump
  // with the new row in one revision and one envelope.
  startRound(
    send: ActiveSend,
    transition?: { finishReason: string; calls: ToolCall[] },
  ): Message {
    const now = this.deps.clock();
    return transact(this.deps.db, () => {
      const changed: Message[] = [];
      if (transition !== undefined && send.round !== null) {
        const previous = this.finishReplyRow(
          send.round,
          "done",
          null,
          "work",
          transition.calls,
          now,
          transition.finishReason,
        );
        if (previous !== null) changed.push(previous);
        const created = this.newToolRows(send, transition.calls, now);
        for (const row of created) {
          changed.push(
            this.deps.sessions.finishTool(row.id, {
              content: NOT_RUN,
              status: "stopped",
              error: null,
              finishedAt: now,
            })!,
          );
        }
        this.recordUsage(send, send.round, now);
      }
      const reply = this.deps.sessions.addReply({
        sessionId: send.sessionId,
        sendId: send.id,
        round: send.roundNo + 1,
        agentId: send.policy.agentId,
        model: send.policy.model,
        now,
      });
      changed.push(reply);
      const sendRow = this.deps.sessions.bumpCounters(send.id, {
        rounds: send.roundNo + 1,
        toolCalls: send.budget.calls,
      });
      const session = this.session(send.sessionId, now);
      return {
        result: reply,
        events: [envelope(session, changed, sendRow)],
      };
    });
  }

  // the round's reply as it ends and its usage, inside the caller's
  // transaction; a null slot becomes answer. The finished row, or null
  // when it was not streaming
  finalizeRound(
    send: ActiveSend,
    status: Exclude<SessionStatus, "running">,
    error: string | null,
    now: number,
  ): Message | null {
    const round = send.round;
    if (round === null) return null;
    // a round cut after its first call delta keeps work; otherwise the
    // reply is the answer, an empty stopped row included
    const slot = round.slotMarked ? "work" : "answer";
    const message = this.finishReplyRow(round, status, error, slot, null, now);
    this.recordUsage(send, round, now);
    return message;
  }

  // called exactly once per send, by the winner of the terminal
  // transition: the last round finalized when one is streaming, any
  // open tool rows stopped, the send's end and the session's state.
  // One transaction, one envelope
  finalizeSend(
    send: ActiveSend,
    cause: SendCause,
    error: string | null,
  ): { session: SessionSummary; reply: Message | null; send: SendSummary } {
    const now = this.deps.clock();
    const status = statusOf(cause);
    const result = transact(this.deps.db, () => {
      // a work reply is never finalized twice: finalizeRound runs only
      // when a round is streaming
      const reply =
        send.round !== null
          ? this.finalizeRound(send, status, error, now)
          : null;
      // the round's tool rows still streaming are stopped; a guard means
      // a late tool that already wrote returns null
      const stopped: Message[] = [];
      for (const rowId of send.openTools.values()) {
        const row = this.deps.sessions.finishTool(rowId, {
          content: CUT_SHORT,
          status: "stopped",
          error: null,
          finishedAt: now,
        });
        if (row !== null) stopped.push(row);
      }
      const row = this.deps.sessions.finishSend(send.id, {
        status,
        cause,
        error,
        rounds: send.roundNo,
        toolCalls: send.budget.calls,
        finishedAt: now,
      })!;
      const session = this.deps.sessions.touch(send.sessionId, {
        status,
        now,
      })!;
      const changed = [...(reply ? [reply] : []), ...stopped];
      return {
        result: { session, reply, send: row },
        events: [envelope(session, changed, row)],
      };
    });
    send.openTools = new Map();
    return result;
  }
}
