// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The wire rows and their database shapes. Keeping the translations
// separate leaves the store focused on queries and writes.

import type {
  Message,
  RoundUsage,
  SendSummary,
  SessionSummary,
} from "../../shared/contracts/session.ts";
import type { ToolCall } from "../../shared/contracts/tool.ts";
import type {
  MessageKind,
  MessageStatus,
  SendCause,
  SessionStatus,
} from "../../shared/words.ts";
import type { ReasoningDetail } from "../providers/index.ts";

export type SessionRow = SessionSummary;

export type RepairedSession = {
  session: SessionRow;
  messages: Message[];
  send: SendSummary | null;
};

export const STREAM_LIMIT = 100;

export type RawSession = {
  id: string;
  project_id: string;
  owner_id: string;
  agent_id: string;
  origin: "chat";
  title: string;
  status: SessionStatus;
  revision: number;
  created_at: number;
  last_activity_at: number;
};

export type UsagePort = {
  latest(sessionId: string): RoundUsage | null;
  latestFor(sessionIds: string[]): Map<string, RoundUsage>;
};

export const session = (
  raw: RawSession,
  usage: RoundUsage | null,
): SessionRow => ({
  id: raw.id,
  projectId: raw.project_id,
  ownerId: raw.owner_id,
  agentId: raw.agent_id,
  origin: raw.origin,
  title: raw.title,
  status: raw.status,
  revision: raw.revision,
  createdAt: raw.created_at,
  lastActivityAt: raw.last_activity_at,
  usage,
});

export type RawMessage = {
  id: string;
  session_id: string;
  seq: number;
  kind: MessageKind;
  send_id: string;
  round: number;
  slot: "work" | "answer" | null;
  user_id: string | null;
  agent_id: string | null;
  content: string;
  reasoning: string;
  html: string;
  status: MessageStatus;
  error: string | null;
  finish_reason: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  model: string | null;
  ttft_ms: number | null;
  thinking_ms: number | null;
  created_at: number;
  finished_at: number | null;
};

export const MESSAGE_COLUMNS =
  "id, session_id, seq, kind, send_id, round, slot, user_id, agent_id, content, reasoning, html, status, error, finish_reason, tool_calls, tool_call_id, tool_name, model, ttft_ms, thinking_ms, created_at, finished_at";

const toolCalls = (raw: string | null): ToolCall[] | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
};

export const message = (raw: RawMessage): Message => ({
  id: raw.id,
  sessionId: raw.session_id,
  seq: raw.seq,
  kind: raw.kind,
  sendId: raw.send_id,
  round: raw.round,
  slot: raw.slot,
  userId: raw.user_id,
  agentId: raw.agent_id,
  content: raw.content,
  reasoning: raw.reasoning,
  html: raw.html,
  status: raw.status,
  error: raw.error,
  finishReason: raw.finish_reason,
  toolCalls: toolCalls(raw.tool_calls),
  toolCallId: raw.tool_call_id,
  toolName: raw.tool_name,
  model: raw.model,
  ttftMs: raw.ttft_ms,
  thinkingMs: raw.thinking_ms,
  createdAt: raw.created_at,
  finishedAt: raw.finished_at,
});

export type RawSend = {
  id: string;
  session_id: string;
  kind: "chat";
  user_id: string;
  agent_id: string;
  provider_id: string;
  model: string;
  status: SessionStatus;
  cause: SendCause | null;
  error: string | null;
  first_message_id: string;
  rounds: number;
  tool_calls: number;
  started_at: number;
  finished_at: number | null;
};

export const send = (raw: RawSend): SendSummary => ({
  id: raw.id,
  sessionId: raw.session_id,
  kind: raw.kind,
  userId: raw.user_id,
  agentId: raw.agent_id,
  providerId: raw.provider_id,
  model: raw.model,
  status: raw.status,
  cause: raw.cause,
  error: raw.error,
  firstMessageId: raw.first_message_id,
  rounds: raw.rounds,
  toolCalls: raw.tool_calls,
  startedAt: raw.started_at,
  finishedAt: raw.finished_at,
});

export type ReplyFinish = {
  content: string;
  reasoning: string;
  reasoningDetails: ReasoningDetail[];
  html: string;
  status: Exclude<MessageStatus, "streaming">;
  error: string | null;
  finishReason: string | null;
  slot: "work" | "answer";
  toolCalls: ToolCall[] | null;
  ttftMs: number | null;
  thinkingMs: number | null;
  finishedAt: number;
};
