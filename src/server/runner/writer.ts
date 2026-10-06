// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Durable writes of a send: one transaction, one revision, one envelope each.

import type {
  LiveRetry,
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import type { SocketEvent, VisualFrame } from "../../shared/socket.ts";
import type { SendCause, SessionStatus } from "../../shared/words.ts";
import { writeKeptFiles } from "../bash/index.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import type { ChatEvent } from "../providers/index.ts";
import { envelope } from "../sessions/index.ts";
import type { UsageFields } from "../usage/index.ts";
import { answerLine } from "./envelope.ts";
import { type AlertsPort, alertEvents, runMark } from "./marks.ts";
import type { ToolResult } from "./policy.ts";
import {
  cutCalls,
  finalizeRound,
  finishReplyRow,
  NOT_RUN,
  newToolRows,
  notRun,
  recordUsage,
  stopOpenTools,
} from "./reply-rows.ts";
import { toolFinish } from "./results.ts";
import type { ActiveSend, ChildLink } from "./send.ts";
import {
  type StartDeps,
  type Started,
  type StartFields,
  startSend as startSendRows,
} from "./start.ts";
import { streamDelta, streamRetry, streamVisual } from "./stream.ts";
import {
  type AfterAnswer,
  type CompactFields,
  type StartedCompact,
  startAfterAnswer,
  startCompact as startCompactRows,
} from "./summary.ts";
import type { SessionsPort, UploadsPort } from "./writer-port.ts";

export type { Started } from "./start.ts";
export type { SessionsPort } from "./writer-port.ts";

export type WriterDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  uploads: UploadsPort;
  usage: { record(fields: UsageFields): unknown };
  commitMemory(send: ActiveSend): number | null;
  // a chat's snapshot of the project's note, started with its first send
  // and dropped by a summary, inside the caller's transaction
  views: StartDeps["views"] & { end(sessionId: string): void };
  render: (markdown: string) => string;
  // the stream frames, straight to the watchers
  stream: (sessionId: string, frame: SocketEvent) => void;
  alerts: AlertsPort;
  // a subagent's changed rows, inside its transaction: the frames its
  // parent's watchers get after the commit. A child publishes no
  // envelope, so nothing of it reaches a list, a feed or another
  // connection
  childRows(link: ChildLink, sessionId: string, rows: Message[]): BusEvent[];
};

// a subagent's rows stream to nobody: no watch reaches its session
const unwatched = () => {};

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
  private readonly quiet: WriterDeps;

  constructor(private readonly deps: WriterDeps) {
    this.quiet = { ...deps, stream: unwatched };
  }

  // the events a transaction of the send publishes: a root's envelope,
  // or a subagent's rows to its parent's watchers alone
  private out(
    send: ActiveSend,
    rows: Message[],
    event: () => BusEvent,
  ): BusEvent[] {
    return send.child === null
      ? [event()]
      : this.deps.childRows(send.child, send.sessionId, rows);
  }

  private streams(send: ActiveSend): WriterDeps {
    return send.child === null ? this.deps : this.quiet;
  }

  startSummary(send: ActiveSend): Message {
    return startAfterAnswer(this.deps, send, {
      row: "summary",
      status: "done",
      error: null,
      counters: {},
    });
  }

  startAfterAnswer(send: ActiveSend, next: AfterAnswer): Message {
    return startAfterAnswer(this.deps, send, next);
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
    streamDelta(this.streams(send), send, event);
  }

  visual(
    send: ActiveSend,
    piece: Pick<VisualFrame, "callIndex" | "title" | "html" | "htmlAt">,
  ): void {
    streamVisual(this.streams(send), send, piece);
  }

  // a round began or ended a wait to ask its provider again
  retrying(send: ActiveSend, retry: LiveRetry | null): void {
    streamRetry(this.streams(send), send, retry);
  }

  private session(id: string, now: number): SessionSummary {
    return this.deps.sessions.touch(id, { status: "running", now })!;
  }

  // the first tool call delta of a round: the streaming reply moves into
  // the fold, guarded by its null slot
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
        events: this.out(send, [reply], () => envelope(session, [reply], null)),
      };
    });
  }

  finishRound(
    send: ActiveSend,
    toolNames: string[] = send.round?.calls.map((call) => call.name) ?? [],
  ): { rows: Message[]; toolCalls: number } {
    const round = send.round;
    if (round === null) return { rows: [], toolCalls: 0 };
    const now = this.deps.clock();
    const launched = send.budget.calls + round.calls.length;
    const result = transact(this.deps.db, () => {
      const reply = finishReplyRow(
        this.deps,
        round,
        "done",
        null,
        "work",
        round.calls,
        now,
      );
      recordUsage(this.deps, send, round, now);
      const rows = newToolRows(
        this.deps.sessions,
        send,
        round.calls,
        now,
        toolNames,
      );
      const sendRow = this.deps.sessions.bumpCounters(send.id, {
        rounds: send.roundNo,
        toolCalls: launched,
      });
      const session = this.session(send.sessionId, now);
      const changed = reply ? [reply, ...rows] : rows;
      return {
        result: { rows, toolCalls: launched },
        events: this.out(send, changed, () =>
          envelope(session, changed, sendRow),
        ),
      };
    });
    // openTools is keyed by the call object, so duplicate call ids stay apart
    send.openTools = new Map();
    round.calls.forEach((call, i) => {
      send.openTools.set(call, result.rows[i]!.id);
    });
    round.drafts.clear();
    return result;
  }

  // guarded by status streaming, so a late tool after cleanup writes nothing
  finishTool(send: ActiveSend, call: ToolCall, result: ToolResult): boolean {
    const rowId = send.openTools.get(call);
    if (rowId === undefined) return false;
    const now = this.deps.clock();
    const changed = transact(this.deps.db, () => {
      const row = this.deps.sessions.finishTool(rowId, toolFinish(result, now));
      if (row === null) return { result: false, events: [] };
      if (result.kept?.length) writeKeptFiles(this.deps.db, rowId, result.kept);
      const session = this.session(send.sessionId, now);
      return {
        result: true,
        events: this.out(send, [row], () => envelope(session, [row], null)),
      };
    });
    if (changed) send.openTools.delete(call);
    return changed;
  }

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
      const rows = cutCalls(
        this.deps,
        send,
        round,
        calls,
        finishReason,
        content,
        now,
      );
      const session = this.session(send.sessionId, now);
      return {
        result: undefined,
        events: this.out(send, rows, () => envelope(session, rows, null)),
      };
    });
    round.drafts.clear();
  }

  // the next streaming reply and, on a cap transition, the work reply
  // and not-run calls that led to it
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
        changed.push(
          ...cutCalls(
            this.deps,
            send,
            send.round,
            transition.calls,
            transition.finishReason,
            notRun(transition.finishReason),
            now,
          ),
        );
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
        send.phase === "memory" || send.phase === "attention"
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
        events: this.out(send, changed, () =>
          envelope(session, changed, sendRow),
        ),
      };
    });
    if (transition !== undefined) send.round?.drafts.clear();
    return reply;
  }

  // only the winner of the terminal transition calls it, exactly once
  finalizeSend(
    send: ActiveSend,
    cause: SendCause,
    error: string | null,
  ): { session: SessionSummary; reply: Message | null; send: SendSummary } {
    const now = this.deps.clock();
    const status = statusOf(cause);
    const result = transact(this.deps.db, () => {
      const memorySkipped = this.deps.commitMemory(send);
      const reply = finalizeRound(this.deps, send, status, error, now);
      const stopped = stopOpenTools(this.deps.sessions, send, now);
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
        mark: runMark(send, cause, error),
      })!;
      const alerted = alertEvents(this.deps.alerts, send, cause, now);
      // the send after a summary takes the note as it is then
      if (reply?.kind === "summary" && reply.status === "done") {
        this.deps.views.end(send.sessionId);
      }
      const changed = [...(reply ? [reply] : []), ...stopped];
      const last = answerLine(reply, send.policy.agentName);
      return {
        result: { session, reply, send: row, memorySkipped },
        events: [
          ...this.out(send, changed, () =>
            envelope(session, changed, row, [], last),
          ),
          ...alerted,
        ],
      };
    });
    send.openTools = new Map();
    send.memorySkipped = result.memorySkipped;
    return result;
  }
}
