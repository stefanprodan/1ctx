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

import { contextReserve } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import type {
  ChatMessageIn,
  ChatRequest,
  ReasoningDetail,
  ToolCall,
} from "../providers/index.ts";
import type { SendPolicy } from "./policy.ts";
import { systemPrompt } from "./prompt.ts";

export const SUMMARIZE = `Summarize the conversation so far so that it can continue from the summary alone: the messages before this point are dropped and only the summary is kept. Write Markdown with these sections, terse bullets, no prose:

## Goal
What the user is after.

## Established
The facts, answers and decisions so far, with exact names, numbers, URLs, commands and code identifiers.

## Open
What is still unanswered or in progress.

Do not mention the summary process.`;

export const SUMMARY_LEAD =
  "The conversation so far, summarized; the earlier messages were dropped:";

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
  policy: Pick<
    SendPolicy,
    | "prompt"
    | "projectName"
    | "projectKind"
    | "projectDescription"
    | "fullName"
    | "about"
    | "username"
    | "userId"
    | "automation"
  >,
  lookups: ContextLookups,
  now: number,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [
    { role: "system", content: systemPrompt(policy, now) },
  ];
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "summary" && row.status === "done") {
      out.push({
        role: "user",
        content: `${SUMMARY_LEAD}\n\n${row.content}`,
      });
      start = i + 1;
      break;
    }
  }
  const active = rows.slice(start);
  const byRound = toolRowsByRound(active);
  for (const row of active) {
    if (row.kind === "summary") continue;
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

// what the instruction and the lead line add to the request, and the
// least a summary is asked for when the answer left little room: a
// short summary beats none, and a provider that cannot fit even that
// refuses the round, which ends failed and is tried again next time
export const SUMMARY_MARGIN = 256;
export const SUMMARY_MIN_TOKENS = 128;

// the summary round: the history plus the instruction, no tools and no
// thinking. Its answer is capped by the limit and the reserve, then by
// the room the answer round actually left (its prompt plus completion,
// `used`): a strict provider refuses a request whose prompt and
// max_tokens together pass the window
export function summaryRequest(
  policy: SendPolicy,
  sessionId: string,
  messages: ChatMessageIn[],
  used: number | null = null,
): ChatRequest {
  const window = policy.contextLength;
  const reserve =
    window === null
      ? policy.limits.summaryMaxTokens
      : contextReserve(window, policy.limits.contextReserve);
  let maxTokens = Math.min(policy.limits.summaryMaxTokens, reserve);
  if (window !== null && used !== null) {
    maxTokens = Math.max(
      SUMMARY_MIN_TOKENS,
      Math.min(maxTokens, window - used - SUMMARY_MARGIN),
    );
  }
  return {
    model: policy.model,
    messages: [...messages, { role: "user", content: SUMMARIZE }],
    thinking: false,
    reasoningEffort: null,
    cacheKey: sessionId,
    maxTokens,
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
