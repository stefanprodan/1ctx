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
// row is skipped. The answer round ends the request with the ask as a
// user message, never a stored row. Tested on fixtures,
// malformed histories among them.

import { contextReserve } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { UPLOADS_SUMMARY_LINE, uploadsBlock } from "../../shared/uploads.ts";
import { EFFORTS, type Effort, type Wire } from "../../shared/words.ts";
import { tokens } from "../lib/tokens.ts";
import {
  type ChatMessageIn,
  type ChatRequest,
  type ReasoningDetail,
  requestTokens,
  type ToolCall,
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
  reasoningDetailsOf(
    messageId: string,
    providerId: string,
    model: string,
  ): ReasoningDetail[] | null;
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
    content: row.uploads?.length
      ? `${row.content}\n\n${uploadsBlock(row.uploads)}`
      : row.content,
    ...(name === null ? {} : { name }),
  };
}

// an assistant reply that asked for tools, with a complete set of
// result rows: the calls and the structured reasoning go back
function workMessage(
  row: Message,
  calls: ToolCall[],
  policy: Pick<SendPolicy, "providerId" | "model">,
  lookups: ContextLookups,
): ChatMessageIn {
  const details = lookups.reasoningDetailsOf(
    row.id,
    policy.providerId,
    policy.model,
  );
  return {
    role: "assistant",
    model: row.model ?? undefined,
    content: row.content === "" ? null : row.content,
    toolCalls: calls,
    ...(details ? { reasoningDetails: details } : {}),
  };
}

export const SKILLS_LEAD =
  "These skills were loaded earlier in this chat and still apply. Load one again with the skill tool before relying on it:";

function loadedSkills(
  rows: Message[],
  cut: number,
  offered: Set<string>,
): string[] {
  let start = 0;
  for (let i = cut - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "summary" && row.status === "done") {
      start = i + 1;
      break;
    }
  }
  const calls = new Map<string, ToolCall[]>();
  // a round's tool rows pair with its calls by position, as the writer
  // pairs them, since a provider may repeat a call id
  const positions = new Map<string, number>();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(start, cut)) {
    const key = `${row.sendId}:${row.round}`;
    if (row.kind === "reply" && row.slot === "work") {
      calls.set(key, row.toolCalls ?? []);
      continue;
    }
    if (row.kind !== "tool") continue;
    const index = positions.get(key) ?? 0;
    positions.set(key, index + 1);
    if (row.status !== "done" || row.toolName !== "skill") continue;
    const call = calls.get(key)?.[index];
    if (call?.id !== row.toolCallId || call.name !== "skill") continue;
    try {
      const args = JSON.parse(call.arguments || "{}") as Record<
        string,
        unknown
      >;
      if (
        typeof args.name === "string" &&
        offered.has(args.name) &&
        !seen.has(args.name)
      ) {
        seen.add(args.name);
        names.push(args.name);
      }
    } catch {}
  }
  return names;
}

export function history(
  rows: Message[],
  policy: Pick<
    SendPolicy,
    | "prompt"
    | "agentName"
    | "projectName"
    | "projectKind"
    | "projectDescription"
    | "fullName"
    | "about"
    | "tz"
    | "username"
    | "userId"
    | "providerId"
    | "model"
    | "automation"
    | "offered"
    | "projectMemory"
    | "automationMemory"
    | "knowledge"
    | "disabledCapabilities"
    | "mcpOff"
    | "skillsOff"
  >,
  lookups: ContextLookups,
  now: number,
  mcpNote = "",
): ChatMessageIn[] {
  return [
    { role: "system", content: systemPrompt(policy, now, mcpNote) },
    ...historyMessages(rows, policy, lookups),
  ];
}

export function historyMessages(
  rows: Message[],
  policy: Pick<
    SendPolicy,
    "username" | "userId" | "providerId" | "model" | "offered"
  >,
  lookups: ContextLookups,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [];
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "summary" && row.status === "done") {
      const names = loadedSkills(
        rows,
        i,
        new Set(policy.offered.skills.skills.map((skill) => skill.name)),
      );
      const remembered =
        names.length === 0 ? "" : `\n\n${SKILLS_LEAD} ${names.join(", ")}`;
      const uploads = rows
        .slice(0, i)
        .some((row) => row.kind === "user" && row.uploads?.length)
        ? `\n\n${UPLOADS_SUMMARY_LINE}`
        : "";
      out.push({
        role: "user",
        content: `${SUMMARY_LEAD}\n\n${row.content}${remembered}${uploads}`,
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
        out.push(workMessage(row, calls, policy, lookups));
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
        out.push({
          role: "assistant",
          model: row.model ?? undefined,
          content: row.content,
        });
      }
      continue;
    }
    if (row.content === "") continue;
    const details = lookups.reasoningDetailsOf(
      row.id,
      policy.providerId,
      policy.model,
    );
    out.push({
      role: "assistant",
      model: row.model ?? undefined,
      content: row.content,
      ...(details ? { reasoningDetails: details } : {}),
    });
  }
  return out;
}

// used when the catalog has no output limit for the model
export const OUTPUT_FALLBACK = 32_000;
// no reply needs more, however much the model allows
export const OUTPUT_MAX = 256_000;
// what is counted here is o200k, which can run low on another vendor's
// tokens and on dense text such as code
export const ESTIMATE_ERROR = 0.15;
// never ask for less: a short reply is still an answer, and the
// estimate may overstate the prompt
export const OUTPUT_MIN = 1_024;

// the most tokens a round asks for: the model's own limit, bounded, and
// fitted to the room the prompt leaves in the window when it is known.
// measured is what the provider counted of the prompt so far, estimated
// what was added since and counted here, the part that may run low
export function outputCap(
  outputLimit: number | null,
  contextLength: number | null,
  measured: number,
  estimated: number,
): number {
  const requested = Math.min(outputLimit ?? OUTPUT_FALLBACK, OUTPUT_MAX);
  if (contextLength === null) return requested;
  const room =
    contextLength - measured - Math.ceil(estimated * (1 + ESTIMATE_ERROR));
  return Math.min(requested, Math.max(OUTPUT_MIN, room));
}

// the last round the provider counted: its prompt and reply in tokens,
// and the messages it was sent, which the next round's request extends
export type Measured = { tokens: number; messages: ChatMessageIn[] };

// a round's request with its cap, and the prompt's size in tokens when
// it was counted (null when no window asked for it)
export type Sized = { request: ChatRequest; estimate: number | null };

// the messages a request added after the measured ones, or null when
// it does not extend them (the first round, a phase's own packet)
function addedSince(
  messages: ChatMessageIn[],
  measured: Measured | null,
): ChatMessageIn[] | null {
  if (measured === null) return null;
  const before = measured.messages;
  if (before.length === 0 || before.length > messages.length) return null;
  const at = before.length - 1;
  if (JSON.stringify(before[at]) !== JSON.stringify(messages[at])) {
    return null;
  }
  return messages.slice(before.length);
}

// a chat, run or memory round with its cap. A model whose limit was
// never read sends none, as before the catalog kept it; the prompt is
// counted only when there is a window to fit, and then only what the
// last counted round did not cover
export function sized(
  req: ChatRequest,
  policy: Pick<SendPolicy, "outputLimit" | "outputRead" | "contextLength">,
  measured: Measured | null = null,
): Sized {
  if (!policy.outputRead) return { request: req, estimate: null };
  let base = 0;
  let estimated = 0;
  let estimate: number | null = null;
  if (policy.contextLength !== null) {
    const added = addedSince(req.messages, measured);
    if (added === null) {
      estimated = requestTokens(req);
      estimate = estimated;
    } else {
      base = measured!.tokens;
      estimated = tokens(JSON.stringify(added));
      estimate = base + estimated;
    }
  }
  return {
    request: {
      ...req,
      maxTokens: outputCap(
        policy.outputLimit,
        policy.contextLength,
        base,
        estimated,
      ),
    },
    estimate,
  };
}

export function sizedRequest(
  policy: SendPolicy,
  sessionId: string,
  messages: ChatMessageIn[],
  measured: Measured | null = null,
): Sized {
  return sized(
    {
      model: policy.model,
      messages,
      thinking: policy.thinking,
      thinkingOff: policy.thinkingOff,
      reasoningEffort: policy.effort,
      cacheKey: sessionId,
      upstream: policy.upstream,
      skip4Bit: policy.skip4Bit,
      ...(policy.offered.tools.length > 0
        ? { tools: policy.offered.tools }
        : {}),
    },
    policy,
    measured,
  );
}

export function request(
  policy: SendPolicy,
  sessionId: string,
  messages: ChatMessageIn[],
  measured: Measured | null = null,
): ChatRequest {
  return sizedRequest(policy, sessionId, messages, measured).request;
}

// what the instruction and the lead line add to the request, and the
// least a summary is asked for when the answer left little room: a
// short summary beats none, and a provider that cannot fit even that
// refuses the round, which ends failed and is tried again next time
export const SUMMARY_MARGIN = 256;
export const SUMMARY_MIN_TOKENS = 128;

const leastEffort = (wire: Wire | null): Effort | null =>
  wire === null ? null : EFFORTS[wire][0];

// the summary round: the history plus the instruction, no tools and no
// thinking, or the least effort the wire names for a model that always
// thinks, since its thoughts come out of the same cap. Its answer is
// capped by the limit and the reserve, then by the room the answer round
// actually left (its prompt plus completion, `used`): a strict provider
// refuses a request whose prompt and max_tokens together pass the window
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
    thinking: policy.thinkingRequired,
    thinkingOff: policy.thinkingOff,
    reasoningEffort: policy.thinkingRequired ? leastEffort(policy.wire) : null,
    cacheKey: sessionId,
    upstream: policy.upstream,
    skip4Bit: policy.skip4Bit,
    maxTokens,
  };
}

// the ask the answer round ends with: a request-local user message after
// the last tool result, never a stored row and never the system prompt.
// Inside a tool result the models read it as more output and called
// again; as the user's words they answered. The schemas stay untouched
// so the cached prefix holds
const ANSWER_NOW =
  "You cannot call tools any more in this turn. Answer the user now from the results above: what you found, what is missing, and what to do next.";
export const EXHAUSTED_LINE = `The tool budget for this turn is spent. ${ANSWER_NOW}`;
export const LOOP_LINE = `You made the same calls three times in a row. ${ANSWER_NOW}`;
// what the ask adds to a request: the longer line and a message's framing
export const ASK_TOKENS =
  Math.max(tokens(EXHAUSTED_LINE), tokens(LOOP_LINE)) + 8;

export function withExhausted(
  messages: ChatMessageIn[],
  reason: string,
): ChatMessageIn[] {
  const content = reason === "tool_loop" ? LOOP_LINE : EXHAUSTED_LINE;
  return [...messages, { role: "user", content }];
}
