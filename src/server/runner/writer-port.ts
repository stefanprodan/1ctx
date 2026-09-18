// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sessions store as the writer needs it, declared as the runner's
// own port: compose passes the sessions area's store. Every method is a
// single row write the writer wraps in one transact() with a touch().

import type { Message, SendSummary } from "../../shared/contracts/session.ts";
import type { McpDigest } from "../../shared/mcp.ts";
import type {
  EventSource,
  SendCause,
  SendKind,
  SessionStatus,
} from "../../shared/words.ts";
import type { ReplyFinish, SessionRow } from "../sessions/index.ts";
import type { RoundState } from "./send.ts";

export type SessionsPort = {
  create(fields: {
    id?: string;
    projectId: string;
    ownerId: string;
    agentId: string;
    origin?: "chat" | "automation";
    automationId?: string | null;
    runSource?: EventSource | null;
    title: string;
    now: number;
  }): SessionRow;
  touch(
    id: string,
    fields: { status: SessionStatus; now: number },
  ): SessionRow | null;
  addUserMessage(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    userId: string;
    content: string;
    now: number;
  }): Message;
  replaceSend(
    user: Message,
    newSendId: string,
  ): {
    user: Message;
    removedMessageIds: string[];
    removedSendIds: string[];
  };
  addReply(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    round: number;
    agentId: string;
    model: string;
    now: number;
  }): Message;
  addSummary(fields: {
    id?: string;
    sessionId: string;
    sendId: string;
    round: number;
    agentId: string;
    model: string;
    now: number;
  }): Message;
  writeReply(
    id: string,
    fields: Pick<RoundState, "content" | "reasoning" | "reasoningDetails">,
  ): boolean;
  // the first call delta of a round: a streaming null-slot reply becomes
  // work, guarded so a second delta writes nothing
  markRoundWork(id: string): Message | null;
  // place a null-slot reply's slot without ending it
  markSlot(id: string, slot: "work" | "answer"): Message | null;
  finishReply(id: string, fields: ReplyFinish): Message | null;
  capWork(id: string, finishReason: string): Message | null;
  // one streaming tool row per launched call, in call order
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
  ): Message[];
  // end one tool row by id, guarded by status streaming; null when a
  // terminal cleanup already wrote it
  finishTool(
    id: string,
    fields: {
      content: string;
      status: "done" | "failed" | "stopped";
      error: string | null;
      finishedAt: number;
    },
  ): Message | null;
  createSend(fields: {
    id?: string;
    kind?: SendKind;
    sessionId: string;
    userId: string;
    agentId: string;
    providerId: string;
    model: string;
    firstMessageId: string;
    mcpDigest: McpDigest | null;
    now: number;
  }): SendSummary;
  lastMcpDigest(sessionId: string, excludeSendId: string): McpDigest | null;
  // the running counters as the loop advances, without ending the send
  bumpCounters(
    id: string,
    fields: { rounds: number; toolCalls: number; memoryRound?: number },
  ): SendSummary | null;
  finishSend(
    id: string,
    fields: {
      status: Exclude<SessionStatus, "running">;
      cause: SendCause;
      error: string | null;
      rounds: number;
      toolCalls: number;
      memoryError: string | null;
      memorySkipped: number | null;
      finishedAt: number;
    },
  ): SendSummary | null;
};
