// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The session's rows as the wire takes them: the system prompt, then
// every user message with its author's name, and every reply and tool
// row that carries something. A work reply goes back as an assistant
// message with its tool calls and a null content when it has none; a
// tool row as role tool. Pairing is by (sendId, round) and call order.
//
// The repair is pure: a work reply whose calls lack a complete set of
// result rows is sent without its calls and without its structured
// reasoning, as plain text if it has any, else skipped; an orphan tool
// row is skipped. The answer round appends the exhausted line to a copy
// of the last tool result, never the stored row. Tested on fixtures,
// malformed histories among them.

import type { Message } from "../../shared/contracts/session.ts";
import type {
  ChatMessageIn,
  ChatRequest,
  ReasoningDetail,
  ToolCall,
} from "../providers/index.ts";
import type { SendPolicy } from "./policy.ts";
import { systemPrompt } from "./prompt.ts";

export type ContextLookups = {
  // the author's username, for the name field on the wire
  usernameOf(userId: string): string | null;
  reasoningDetailsOf(messageId: string): ReasoningDetail[] | null;
};

// the tool result rows of one (sendId, round), in call order
function toolRowsByRound(rows: Message[]): Map<string, Message[]> {
  const byRound = new Map<string, Message[]>();
  for (const row of rows) {
    if (row.kind !== "tool") continue;
    const key = `${row.sendId}:${row.round}`;
    const calls = byRound.get(key) ?? [];
    calls.push(row);
    byRound.set(key, calls);
  }
  return byRound;
}

// a user message on the wire, with the author's name when it is not the
// sender and is known
function userMessage(
  row: Message,
  policy: Pick<SendPolicy, "username" | "userId">,
  lookups: ContextLookups,
): ChatMessageIn {
  const name =
    row.userId === policy.userId
      ? policy.username
      : row.userId === null
        ? null
        : lookups.usernameOf(row.userId);
  return {
    role: "user",
    content: row.content,
    ...(name === null ? {} : { name }),
  };
}

// an assistant reply that asked for tools, with a complete set of
// result rows: the calls and the structured reasoning go back
function workMessage(
  row: Message,
  calls: ToolCall[],
  lookups: ContextLookups,
): ChatMessageIn {
  const details = lookups.reasoningDetailsOf(row.id);
  return {
    role: "assistant",
    content: row.content === "" ? null : row.content,
    toolCalls: calls,
    ...(details ? { reasoningDetails: details } : {}),
  };
}

export function history(
  rows: Message[],
  policy: Pick<SendPolicy, "prompt" | "about" | "username" | "userId">,
  lookups: ContextLookups,
  now: number,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [
    { role: "system", content: systemPrompt(policy, now) },
  ];
  const byRound = toolRowsByRound(rows);
  for (const row of rows) {
    if (row.kind === "user") {
      out.push(userMessage(row, policy, lookups));
      continue;
    }
    if (row.kind === "tool") {
      // an orphan tool row (no assistant turn placed it) is skipped by
      // the reply branch below; a paired one is emitted there in order
      continue;
    }
    // a reply row
    if (row.status === "streaming") continue;
    const calls = row.toolCalls ?? [];
    if (row.slot === "work" && calls.length > 0) {
      const key = `${row.sendId}:${row.round}`;
      const resultRows = byRound.get(key);
      const complete =
        resultRows !== undefined &&
        resultRows.length === calls.length &&
        calls.every((call, index) => {
          const result = resultRows[index];
          return result !== undefined && result.toolCallId === call.id;
        });
      if (complete) {
        out.push(workMessage(row, calls, lookups));
        calls.forEach((call, index) => {
          out.push({
            role: "tool",
            toolCallId: call.id,
            content: resultRows[index]!.content,
          });
        });
        continue;
      }
      // the round is incomplete: send it without its calls and without
      // its structured reasoning, as plain text if it has any, else skip
      if (row.content !== "") {
        out.push({ role: "assistant", content: row.content });
      }
      continue;
    }
    if (row.content === "") continue;
    const details = lookups.reasoningDetailsOf(row.id);
    out.push({
      role: "assistant",
      content: row.content,
      ...(details ? { reasoningDetails: details } : {}),
    });
  }
  return out;
}

export function request(
  policy: SendPolicy,
  sessionId: string,
  messages: ChatMessageIn[],
): ChatRequest {
  return {
    model: policy.model,
    messages,
    thinking: policy.thinking,
    reasoningEffort: policy.effort,
    cacheKey: sessionId,
    ...(policy.offered.tools.length > 0 ? { tools: policy.offered.tools } : {}),
  };
}

// the exhausted line the caps reached: it rides on a request-local copy
// of the last tool result, never the stored row and never the system
// prompt. The answer round keeps the schemas (tool_choice none is set
// on the wire) so the cached prefix holds.
export const EXHAUSTED_LINE =
  "The tool budget is spent. Answer now with what the results gave you.";

// append the exhausted line to a copy of the messages, on the last tool
// message when there is one, else as a final user message
export function withExhausted(messages: ChatMessageIn[]): ChatMessageIn[] {
  const copy = messages.slice();
  for (let i = copy.length - 1; i >= 0; i--) {
    const message = copy[i]!;
    if (message.role === "tool") {
      copy[i] = {
        ...message,
        content: `${message.content}\n\n${EXHAUSTED_LINE}`,
      };
      return copy;
    }
  }
  copy.push({ role: "user", content: EXHAUSTED_LINE });
  return copy;
}
