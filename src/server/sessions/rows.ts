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
  EventSource,
  MessageKind,
  MessageStatus,
  SendCause,
  SendKind,
  SessionOrigin,
  SessionStatus,
} from "../../shared/words.ts";
import type { ReasoningDetail } from "../providers/index.ts";

export type CreateSession = {
  id?: string;
  projectId: string;
  ownerId: string;
  agentId: string;
  origin?: "chat" | "automation";
  automationId?: string | null;
  runSource?: EventSource | null;
  title: string;
  now: number;
};
export type SessionRow = SessionSummary;

export type RepairedSession = {
  session: SessionRow;
  messages: Message[];
  send: SendSummary | null;
};

export const STREAM_LIMIT = 100;
export const RESULT_DISPLAY_CHARS = 20_000;

export type RawSession = {
  id: string;
  project_id: string;
  owner_id: string;
  agent_id: string;
  origin: SessionOrigin;
  automation_id: string | null;
  run_source: EventSource | null;
  title: string;
  status: SessionStatus;
  revision: number;
  created_at: number;
  last_activity_at: number;
};

export type UsagePort = {
  latest(sessionId: string): RoundUsage | null;
  latestFor(sessionIds: string[]): Map<string, RoundUsage>;
  deleteSession(sessionId: string): number;
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
  automationId: raw.automation_id,
  runSource: raw.run_source,
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
  prompt_tokens: number | null;
  created_at: number;
  finished_at: number | null;
};

export const MESSAGE_COLUMNS = `messages.id, messages.session_id, messages.seq, messages.kind,
   messages.send_id, messages.round, messages.slot, messages.user_id,
   messages.agent_id, messages.content, messages.reasoning, messages.html,
   messages.status, messages.error, messages.finish_reason,
   messages.tool_calls, messages.tool_call_id, messages.tool_name,
   messages.model, messages.ttft_ms, messages.thinking_ms,
   (select usage.prompt_tokens from usage
    where usage.send_id = messages.send_id and usage.round = messages.round)
    as prompt_tokens,
   messages.created_at, messages.finished_at`;

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
  resultBytes: null,
  promptTokens:
    raw.kind === "summary" && raw.status === "done" ? raw.prompt_tokens : null,
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

// a tool row leaves its result behind: the content, and the error,
// which is the failed result's text. The size says what the result
// route will answer
export function offWire(row: Message): Message {
  if (row.kind !== "tool") return { ...row, resultBytes: null };
  return {
    ...row,
    content: "",
    error: null,
    resultBytes: Buffer.byteLength(row.content, "utf8"),
  };
}

// the display cut, in characters, never inside a surrogate pair
export function cutResult(content: string): { content: string; cut: boolean } {
  if (content.length <= RESULT_DISPLAY_CHARS) return { content, cut: false };
  let end = RESULT_DISPLAY_CHARS;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { content: content.slice(0, end), cut: true };
}

export type RawSend = {
  id: string;
  session_id: string;
  kind: SendKind;
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
  memory_round: number | null;
  memory_error: string | null;
  memory_skipped: number | null;
  tokens: number;
  started_at: number;
  finished_at: number | null;
};

// the send's token count, from its usage rows, for a query over sends
// under the given name
export const sendTokens = (table: string) =>
  `(select coalesce(sum(usage.prompt_tokens + usage.completion_tokens), 0)
     from usage where usage.send_id = ${table}.id) as tokens`;

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
  memoryRound: raw.memory_round,
  memoryError: raw.memory_error,
  memorySkipped: raw.memory_skipped,
  tokens: raw.tokens,
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
  slot: "work" | "answer" | null;
  toolCalls: ToolCall[] | null;
  ttftMs: number | null;
  thinkingMs: number | null;
  finishedAt: number;
};
