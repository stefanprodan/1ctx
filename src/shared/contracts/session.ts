// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A session as the wire exposes it: the row in the stream and the
// project's list, its messages, the send in flight and its live tail.
// The revision counts the session's transactions; a client applies an
// event only when its revision is above the one it holds.

import type {
  MessageKind,
  MessageStatus,
  SendCause,
  SessionStatus,
} from "../words.ts";

export type SessionSummary = {
  id: string;
  projectId: string;
  ownerId: string;
  agentId: string;
  origin: "chat";
  // the first line of the first message, cut to 80 characters
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
  // who wrote it: a user for a user message, an agent for a reply
  userId: string | null;
  agentId: string | null;
  content: string;
  reasoning: string;
  // the rendered content, empty for a user message
  html: string;
  status: MessageStatus;
  error: string | null;
  finishReason: string | null;
  model: string | null;
  ttftMs: number | null;
  thinkingMs: number | null;
  createdAt: number;
  finishedAt: number | null;
};

export type SendSummary = {
  id: string;
  sessionId: string;
  kind: "chat";
  userId: string;
  agentId: string;
  providerId: string;
  model: string;
  status: SessionStatus;
  cause: SendCause | null;
  error: string | null;
  // the user message the send answers
  firstMessageId: string;
  startedAt: number;
  finishedAt: number | null;
};

// the runner's snapshot of a send in flight: the reply as far as it
// got, and the stream sequence the next frame follows
export type LiveSend = {
  sendId: string;
  messageId: string;
  seq: number;
  content: string;
  reasoning: string;
  html: string;
  htmlAt: number;
};

export type SessionDetail = {
  session: SessionSummary;
  messages: Message[];
  // the send in flight, or the last one; null before the first
  send: SendSummary | null;
  live: LiveSend | null;
};
