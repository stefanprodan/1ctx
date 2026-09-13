// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Persistence and the socket frames of a send. Three transactions over
// transact(): startSend writes the user message, the reply row, the
// send row and the session's running state; finalizeRound writes the
// round's reply and its usage row; finalizeSend writes the send's end
// and the session's state, finalizing the last round inside it. Each
// bumps the revision once and publishes one envelope after commit.
// Between them the reply in flight is checkpointed every 250 ms or
// 2 KB, which bumps nothing, and rendered every second for the
// watchers.

import type {
  Message,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { SocketEvent } from "../../shared/socket.ts";
import type { SendCause, SessionStatus } from "../../shared/words.ts";
import { type Db, transact } from "../db/index.ts";
import type { BusEvent } from "../lib/bus.ts";
import type { Clock } from "../lib/clock.ts";
import type { ChatEvent, Usage } from "../providers/index.ts";
import type { ReplyFinish, SessionRow } from "../sessions/index.ts";
import type { UsageFields } from "../usage/index.ts";
import type { SendPolicy } from "./policy.ts";
import type { ActiveSend, RoundState } from "./send.ts";

export const WRITE_EVERY_MS = 250;
export const WRITE_EVERY_BYTES = 2048;
export const HTML_EVERY_MS = 1000;

export type SessionsPort = {
  create(fields: {
    id?: string;
    projectId: string;
    ownerId: string;
    agentId: string;
    title: string;
    now: number;
  }): SessionRow;
  touch(
    id: string,
    fields: { status: SessionStatus; now: number },
  ): SessionRow | null;
  addUserMessage(fields: {
    sessionId: string;
    userId: string;
    content: string;
    now: number;
  }): Message;
  addReply(fields: {
    sessionId: string;
    agentId: string;
    model: string;
    now: number;
  }): Message;
  writeReply(
    id: string,
    fields: Pick<RoundState, "content" | "reasoning" | "reasoningDetails">,
  ): boolean;
  finishReply(id: string, fields: ReplyFinish): Message | null;
  createSend(fields: {
    sessionId: string;
    userId: string;
    agentId: string;
    providerId: string;
    model: string;
    firstMessageId: string;
    now: number;
  }): SendSummary;
  finishSend(
    id: string,
    fields: {
      status: Exclude<SessionStatus, "running">;
      cause: SendCause;
      error: string | null;
      finishedAt: number;
    },
  ): SendSummary | null;
};

export type WriterDeps = {
  db: Db;
  clock: Clock;
  sessions: SessionsPort;
  usage: { record(fields: UsageFields): unknown };
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

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

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
): BusEvent => ({
  type: "session.changed",
  data: { projectId: session.projectId, session, messages, send },
});

export class Writer {
  constructor(private readonly deps: WriterDeps) {}

  // with the lock already held: the session when it is new, the user
  // message, the reply row that streams, the send row, the running
  // state. One transaction, one envelope
  startSend(fields: {
    sessionId: string;
    session: SessionRow | null;
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
      const user = this.deps.sessions.addUserMessage({
        sessionId: base.id,
        userId: policy.userId,
        content: fields.text,
        now,
      });
      const reply = this.deps.sessions.addReply({
        sessionId: base.id,
        agentId: policy.agentId,
        model: policy.model,
        now,
      });
      const send = this.deps.sessions.createSend({
        sessionId: base.id,
        userId: policy.userId,
        agentId: policy.agentId,
        providerId: policy.providerId,
        model: policy.model,
        firstMessageId: user.id,
        now,
      });
      const session = this.deps.sessions.touch(base.id, {
        status: "running",
        now,
      })!;
      return {
        result: { session, user, reply, send },
        events: [envelope(session, [user, reply], send)],
      };
    });
  }

  // a piece of the reply: the round grows, the watchers hear, the
  // checkpoint and the render follow their cadence
  delta(
    send: ActiveSend,
    event: Extract<ChatEvent, { kind: "reasoning" | "content" }>,
  ): void {
    const round = send.round;
    const now = this.deps.clock();
    const contentAt = round.content.length;
    const reasoningAt = round.reasoning.length;
    if (round.ttftMs === null) round.ttftMs = now - round.startedAt;
    if (event.kind === "content") {
      if (round.reasoningStartedAt !== null && round.thinkingMs === null) {
        round.thinkingMs = now - round.reasoningStartedAt;
      }
      round.content += event.text;
    } else {
      if (round.reasoningStartedAt === null) round.reasoningStartedAt = now;
      round.reasoning += event.text;
    }
    send.seq++;
    this.deps.stream(send.sessionId, {
      type: "delta",
      sessionId: send.sessionId,
      sendId: send.id,
      messageId: round.messageId,
      seq: send.seq,
      ...(event.kind === "content" ? { content: event.text } : {}),
      contentAt,
      ...(event.kind === "reasoning" ? { reasoning: event.text } : {}),
      reasoningAt,
    });
    this.checkpoint(round, now);
    if (
      event.kind === "content" &&
      round.content.length > round.htmlAt &&
      now - round.lastHtmlAt >= HTML_EVERY_MS
    ) {
      round.lastHtmlAt = now;
      round.htmlAt = round.content.length;
      round.html = this.deps.render(round.content, true);
      send.seq++;
      this.deps.stream(send.sessionId, {
        type: "html",
        sessionId: send.sessionId,
        sendId: send.id,
        messageId: round.messageId,
        seq: send.seq,
        html: round.html,
        htmlAt: round.htmlAt,
      });
    }
  }

  private checkpoint(round: RoundState, now: number): void {
    const size = bytes(round.content) + bytes(round.reasoning);
    if (
      now - round.lastWriteAt < WRITE_EVERY_MS &&
      size - round.lastWriteSize < WRITE_EVERY_BYTES
    ) {
      return;
    }
    if (this.deps.sessions.writeReply(round.messageId, round)) {
      round.lastWriteAt = now;
      round.lastWriteSize = size;
    }
  }

  // the round's reply as it ends and its usage, inside the caller's
  // transaction; the finished row, or null when it was not streaming
  finalizeRound(
    send: ActiveSend,
    status: Exclude<SessionStatus, "running">,
    error: string | null,
    now: number,
  ): Message | null {
    const round = send.round;
    const thinkingMs =
      round.thinkingMs ??
      (round.reasoningStartedAt === null
        ? null
        : now - round.reasoningStartedAt);
    const message = this.deps.sessions.finishReply(round.messageId, {
      content: round.content,
      reasoning: round.reasoning,
      reasoningDetails: round.reasoningDetails,
      html: this.deps.render(round.content, false),
      status,
      error,
      finishReason: round.finishReason,
      ttftMs: round.ttftMs,
      thinkingMs,
      finishedAt: now,
    });
    const usage: Usage | null = round.usage;
    if (usage !== null) {
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
    return message;
  }

  // called exactly once per send, by the winner of the terminal
  // transition: the last round, the send's end, the session's state
  finalizeSend(
    send: ActiveSend,
    cause: SendCause,
    error: string | null,
  ): { session: SessionSummary; reply: Message | null; send: SendSummary } {
    const now = this.deps.clock();
    const status = statusOf(cause);
    return transact(this.deps.db, () => {
      const reply = this.finalizeRound(send, status, error, now);
      const row = this.deps.sessions.finishSend(send.id, {
        status,
        cause,
        error,
        finishedAt: now,
      })!;
      const session = this.deps.sessions.touch(send.sessionId, {
        status,
        now,
      })!;
      return {
        result: { session, reply, send: row },
        events: [envelope(session, reply ? [reply] : [], row)],
      };
    });
  }
}
