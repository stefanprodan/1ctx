// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A session as the wire exposes it: the row in the stream and the
// project's list, its messages, the send in flight and its live tail.
// The revision counts the session's transactions; a client applies an
// event only when its revision is above the one it holds.

import type {
  EventSource,
  MessageKind,
  MessageStatus,
  SendCause,
  SendKind,
  SessionOrigin,
  SessionStatus,
} from "../words.ts";
import type { ToolCall } from "./tool.ts";

export type SessionSummary = {
  id: string;
  projectId: string;
  ownerId: string;
  agentId: string;
  origin: SessionOrigin;
  // the automation a run belongs to; null for a chat, and for a run
  // whose automation was deleted
  automationId: string | null;
  // what started a run: its schedule, or someone's Run now, who owns
  // the session; null for a chat
  runSource: EventSource | null;
  // the first line of the first message, cut to 80 characters; a
  // run's is its automation's name
  title: string;
  status: SessionStatus;
  revision: number;
  createdAt: number;
  lastActivityAt: number;
  // the last round the provider counted; null before the first
  usage: RoundUsage | null;
};

// what the provider counted for one round: the prompt is the whole
// request, so prompt plus completion is the context the session used.
// The window is the model's as the round saw it, since an agent's
// model can change under a session
export type RoundUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  // USD, when the provider states one
  cost: number | null;
  contextLength: number | null;
};

export type Message = {
  id: string;
  sessionId: string;
  // the order within the session
  seq: number;
  kind: MessageKind;
  // the send this row belongs to; every message row carries it, so the
  // client groups a send's rows without reading the call arrays
  sendId: string;
  // the provider round within the send, from 1; the answer round included
  round: number;
  // the server's word on where a reply row shows: "answer" in the main
  // column, "work" inside the fold; null while a reply streams and on
  // every non-reply row
  slot: "work" | "answer" | null;
  // who wrote it: a user for a user message, an agent for a reply
  userId: string | null;
  agentId: string | null;
  // a tool result stays in storage but travels as empty content; every
  // other row carries its content unchanged
  content: string;
  // the UTF-8 byte length of stored tool content on the wire; null on
  // every non-tool row
  resultBytes: number | null;
  // the context sent to a completed summary round; null otherwise
  promptTokens: number | null;
  reasoning: string;
  // the rendered content, empty for a user message
  html: string;
  status: MessageStatus;
  error: string | null;
  finishReason: string | null;
  // the calls a reply row asked for, null on every other row; read for
  // rendering the fold, never for placement
  toolCalls: ToolCall[] | null;
  // the call a tool row answers and the tool that ran, both null on
  // every other row
  toolCallId: string | null;
  toolName: string | null;
  model: string | null;
  ttftMs: number | null;
  thinkingMs: number | null;
  createdAt: number;
  finishedAt: number | null;
};

// the last row a person or the agent wrote to a chat, as the stream
// shows it: a user message, or an answer reply that is done. The
// author is the username or the agent's name; the text is the first
// non-empty line of the content with its leading markers stripped,
// cut to the cap
export type LastLine = {
  seq: number;
  author: string;
  text: string;
};

export const MAX_LAST_LINE = 160;

export type SendSummary = {
  id: string;
  sessionId: string;
  kind: SendKind;
  userId: string;
  agentId: string;
  providerId: string;
  model: string;
  status: SessionStatus;
  cause: SendCause | null;
  error: string | null;
  // the user message the send answers
  firstMessageId: string;
  // provider rounds so far, the answer round included; from 1
  rounds: number;
  // tool calls launched, not calls a cap cut
  toolCalls: number;
  // the round the memory phase started at; null for a send without one
  memoryRound: number | null;
  // why the memory phase did not update the note, null when it did
  memoryError: string | null;
  // edits the commit skipped because the note moved during the run
  memorySkipped: number | null;
  // prompt plus completion tokens over every round the provider counted
  tokens: number;
  startedAt: number;
  finishedAt: number | null;
};

// the runner's snapshot of a send in flight. Between rounds, while a
// round's tools run, nothing streams: the "tools" variant carries the
// send and the stream sequence but no row, and the client must accept
// that without seeding a live row and without a refetch. The "reply"
// variant is a reply streaming, as before
export type LiveSend =
  | {
      phase: "reply";
      sendId: string;
      messageId: string;
      seq: number;
      content: string;
      reasoning: string;
      html: string;
      htmlAt: number;
    }
  | {
      phase: "tools";
      sendId: string;
      seq: number;
    };

export type SessionDetail = {
  session: SessionSummary;
  messages: Message[];
  // the send in flight, or the last one; null before the first
  send: SendSummary | null;
  live: LiveSend | null;
};
