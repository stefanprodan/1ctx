// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Persistence and the socket frames of a send. Each durable change is
// one transaction with one revision and one envelope after commit.
// startSend opens the send; delta streams without a revision, and the reply
// moves into the fold at the first tool call; finishRound ends a work
// round and launches tools; finishTool ends one; cut calls are recorded not run.
// startRound begins the next round; finalizeSend ends the send once.

import type {
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import type { SocketEvent, VisualFrame } from "../../shared/socket.ts";
import type { SendCause, SessionStatus } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import { writeKeptFiles } from "../knowledge/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { ChatEvent, Usage } from "../providers/index.ts";
import type { UsageFields } from "../usage/index.ts";
import { envelope, lastLine } from "./envelope.ts";
import type { ToolResult } from "./policy.ts";
import type { ActiveSend, RoundState } from "./send.ts";
import {
  type StartDeps,
  type Started,
  type StartFields,
  startSend as startSendRows,
} from "./start.ts";
import { streamDelta, streamVisual } from "./stream.ts";
import {
  type CompactFields,
  type StartedCompact,
  startCompact as startCompactRows,
  startSummary as startSummaryRows,
} from "./summary.ts";
import type { SessionsPort, UploadsPort } from "./writer-port.ts";

export type { Started } from "./start.ts";
export { HTML_EVERY_MS, WRITE_EVERY_BYTES, WRITE_EVERY_MS } from "./stream.ts";
export type { SessionsPort } from "./writer-port.ts";

// the text a call cut before it ran gets, as its content
export const NOT_RUN = "not run: the tool budget was spent";
export const NOT_RUN_LOOP = "not run: the same calls came three times in a row";
// the loop check's first trip: the calls are refused and the loop goes on
export const NOT_RUN_REPEAT =
  "not run: the same calls as your previous two rounds, and their results are above. Use them, call something else, or answer.";

export function notRun(reason: string): string {
  return reason === "tool_loop" ? NOT_RUN_LOOP : NOT_RUN;
}
// the text a call still running when the send ended gets
export const CUT_SHORT = "stopped before it finished";

export type WriterDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  uploads: UploadsPort;
  usage: {
    record(fields: UsageFields): unknown;
    deleteSend(sendId: string): boolean;
  };
  commitMemory(send: ActiveSend): number | null;
  // a chat's snapshot of the project's note, started with its first send
  // and dropped by a summary, inside the caller's transaction
  views: StartDeps["views"] & { end(sessionId: string): void };
  render: (markdown: string, streaming: boolean) => string;
  // the stream frames, straight to the watchers
  stream: (sessionId: string, frame: SocketEvent) => void;
};

// the status a cause ends in
export function statusOf(cause: SendCause): Exclude<SessionStatus, "running"> {
  switch (cause) {
    case "finish":
      return "done";
    case "stop":
    case "shutdown":
    case "deadline":
      return "stopped";
    default:
      return "failed";
  }
}

export class Writer {
  constructor(private readonly deps: WriterDeps) {}

  startSummary(send: ActiveSend): Message {
    return startSummaryRows(this.deps, send);
  }

  startCompact(fields: CompactFields): StartedCompact {
    return startCompactRows(this.deps, fields);
  }

  startSend(fields: StartFields): Started {
    return startSendRows(this.deps, fields);
  }

  delta(
    send: ActiveSend,
    event: Extract<ChatEvent, { kind: "reasoning" | "content" }>,
  ): void {
    streamDelta(this.deps, send, event);
  }

  visual(
    send: ActiveSend,
    piece: Pick<VisualFrame, "callIndex" | "title" | "html" | "htmlAt">,
  ): void {
    streamVisual(this.deps, send, piece);
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
    slot: "work" | "answer" | null,
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
      upstream: round.upstream,
      servedModel: round.servedModel,
      nativeFinish: round.nativeFinish,
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
      upstream: round.upstream,
      servedModel: round.servedModel,
      now,
    });
  }

  private newToolRows(
    send: ActiveSend,
    calls: ToolCall[],
    now: number,
    toolNames: string[] = calls.map((call) => call.name),
  ) {
    return this.deps.sessions.addToolRows(
      calls.map((call, index) => ({
        sessionId: send.sessionId,
        sendId: send.id,
        round: send.roundNo,
        toolCallId: call.id,
        toolName: toolNames[index] ?? call.name,
        now,
      })),
    );
  }

  // a work round that ends with calls to run: the reply done as work
  // with its calls, its usage, one streaming tool row per call, the
  // send's counters bumped. One revision, one envelope with every row.
  // The launched tool rows are tracked on the send, by call id, so the
  // loop's finishTool and a terminal cleanup find them
  finishRound(
    send: ActiveSend,
    toolNames: string[] = send.round?.calls.map((call) => call.name) ?? [],
  ): { rows: Message[]; toolCalls: number } {
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
      const rows = this.newToolRows(send, round.calls, now, toolNames);
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
    round.drafts.clear();
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
        opened: result.opened,
      });
      if (row === null) return { result: false, events: [] };
      if (result.kept?.length) writeKeptFiles(this.deps.db, rowId, result.kept);
      const session = this.session(send.sessionId, now);
      return { result: true, events: [envelope(session, [row], null)] };
    });
    if (changed) send.openTools.delete(call);
    return changed;
  }

  // a round the loop cut before its calls ran: the reply done as work
  // with the given finish reason, the calls written stopped with the
  // not-run text. One revision, one envelope with every row
  recordUnrun(
    send: ActiveSend,
    finishReason: string,
    calls: ToolCall[],
    content = NOT_RUN,
  ): void {
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
            content,
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
    round.drafts.clear();
  }

  // the next streaming reply and, on a cap transition, the work reply
  // and not-run calls that led to it. The round number and counters bump
  // with the new row in one revision and one envelope.
  startRound(
    send: ActiveSend,
    transition?: { finishReason: string } & (
      | { calls: ToolCall[] }
      | { messageId: string }
    ),
  ): Message {
    const now = this.deps.clock();
    const reply = transact(this.deps.db, () => {
      const changed: Message[] = [];
      if (transition !== undefined && "messageId" in transition) {
        const previous = this.deps.sessions.capWork(
          transition.messageId,
          transition.finishReason,
        );
        if (previous !== null) changed.push(previous);
      }
      if (
        transition !== undefined &&
        "calls" in transition &&
        send.round !== null
      ) {
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
              content: notRun(transition.finishReason),
              status: "stopped",
              error: null,
              finishedAt: now,
            })!,
          );
        }
        this.recordUsage(send, send.round, now);
      }
      const created = this.deps.sessions.addReply({
        sessionId: send.sessionId,
        sendId: send.id,
        round: send.roundNo + 1,
        agentId: send.policy.agentId,
        model: send.policy.model,
        now,
      });
      const reply =
        send.phase === "memory"
          ? (this.deps.sessions.markSlot(created.id, "work") ?? created)
          : created;
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
    if (transition !== undefined) send.round?.drafts.clear();
    return reply;
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
    const memory = send.phase === "memory";
    const slot = memory
      ? "work"
      : send.summarizing
        ? null
        : round.slotMarked
          ? "work"
          : "answer";
    const finalStatus = memory
      ? send.memoryError !== null
        ? "failed"
        : send.memoryStopped
          ? "stopped"
          : "done"
      : status;
    const finalError = memory ? send.memoryError : error;
    this.recordUsage(send, round, now);
    return this.finishReplyRow(round, finalStatus, finalError, slot, null, now);
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
      const memorySkipped = this.deps.commitMemory(send);
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
        memoryError: send.memoryError,
        memorySkipped,
        finishedAt: now,
      })!;
      const session = this.deps.sessions.touch(send.sessionId, {
        status,
        now,
      })!;
      // the send after a summary takes the note as it is then
      if (reply?.kind === "summary" && reply.status === "done") {
        this.deps.views.end(send.sessionId);
      }
      const changed = [...(reply ? [reply] : []), ...stopped];
      const last =
        reply?.status === "done" && reply.slot === "answer"
          ? lastLine(reply, send.policy.agentName)
          : undefined;
      return {
        result: { session, reply, send: row, memorySkipped },
        events: [envelope(session, changed, row, [], last)],
      };
    });
    send.openTools = new Map();
    send.memorySkipped = result.memorySkipped;
    return result;
  }
}
