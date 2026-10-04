// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The session's rows as the wire takes them: the system prompt, then
// the rows (render.ts). After a done summary the history is the summary,
// then the tail (tail.ts), the newest whole turns before it as they
// were, then the rows after it; what came before the tail reaches the
// model only through the summary. The answer round ends the request
// with the ask as a user message, never a stored row.

import { contextReserve } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { toolArguments } from "../../shared/contracts/tool.ts";
import { UPLOADS_SUMMARY_LINE } from "../../shared/uploads.ts";
import type { Wire } from "../../shared/words.ts";
import { tokens } from "../lib/tokens.ts";
import {
  type ChatMessageIn,
  type ChatRequest,
  type ChatTool,
  requestTokens,
  type ToolCall,
} from "../providers/index.ts";
import { leastThinking, type SendPolicy } from "./policy.ts";
import { NO_REPO_LINES, type RepoLines, systemPrompt } from "./prompt.ts";
import {
  type ContextLookups,
  ownTurn,
  type RenderPolicy,
  renderRows,
  roundComplete,
  type Turn,
  toolRowsByRound,
} from "./render.ts";
import { lastSummary, tailBudget, tailOf } from "./tail.ts";

export const SUMMARIZE = `Summarize the conversation so far. The chat continues from your summary, followed by its newest turns as they were when they fit, so cover all of it, the newest turns included. Write Markdown with these sections, terse bullets, no prose:

## Goal
What the user is after.

## Established
The facts, answers and decisions so far, with exact names, numbers, URLs, commands and code identifiers.

## Open
What is still unanswered or in progress.

Do not mention the summary process.`;

export const SUMMARY_LEAD =
  "A summary of the conversation so far. Its newest turns, if any, follow as they were:";

export const SKILLS_LEAD =
  "These skills were loaded earlier in this chat and still apply. Their instructions are not shown here, so load one again with the skill tool before relying on it:";

// the skills the building agent loaded from `from` (the previous
// summary's tail, so a load inside it outlives that tail) up to the
// summary, less those whose result replays in the current tail
function loadedSkills(
  rows: readonly Message[],
  from: number,
  tail: number,
  cut: number,
  offered: Set<string>,
  // the skill was loaded by the building agent itself
  own: (sendId: string) => boolean,
): string[] {
  const calls = new Map<string, ToolCall[]>();
  // a round's tool rows pair with its calls by position, as the writer
  // pairs them, since a provider may repeat a call id
  const positions = new Map<string, number>();
  const names: string[] = [];
  const replayed = new Set<string>();
  const byRound = toolRowsByRound(rows.slice(from, cut));
  for (let i = from; i < cut; i++) {
    const row = rows[i]!;
    if (!own(row.sendId)) continue;
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
    const name = toolArguments(call.arguments)?.name;
    if (typeof name !== "string" || !offered.has(name)) continue;
    // a load in the tail replays only when its round renders whole
    if (i >= tail && roundComplete(calls.get(key)!, byRound.get(key))) {
      replayed.add(name);
    }
    if (!names.includes(name)) names.push(name);
  }
  return names.filter((name) => !replayed.has(name));
}

// what the tail is sized against: the window and reserve the round
// compacts at, the wire that counts, and the rest of the request (the
// system prompt and the schemas) the summary is sent with
export type TailRoom = {
  window: number | null;
  reserve: number;
  wire: Wire | null;
  system: ChatMessageIn[];
  tools: readonly ChatTool[];
};

export function history(
  rows: Message[],
  policy: Pick<
    SendPolicy,
    | "prompt"
    | "agentName"
    | "agentId"
    | "summoned"
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
    | "contextLength"
    | "limits"
    | "wire"
  >,
  lookups: ContextLookups,
  now: number,
  mcpNote = "",
  repos: RepoLines = NO_REPO_LINES,
): ChatMessageIn[] {
  const system: ChatMessageIn = {
    role: "system",
    content: systemPrompt(policy, now, mcpNote, repos),
  };
  return [
    system,
    ...historyMessages(rows, policy, lookups, {
      window: policy.contextLength,
      reserve: policy.limits.contextReserve,
      wire: policy.wire,
      system: [system],
      tools: policy.offered.tools,
    }),
  ];
}

const leadOf = (summary: Message) => `${SUMMARY_LEAD}\n\n${summary.content}`;

// the tail budget after one summary: its base is the request without
// the tail, the summary's lead counted without the lines that depend on
// the tail
function budgetAt(room: TailRoom, model: string, summary: Message): number {
  const base = requestTokens(room.wire, {
    model,
    thinking: false,
    messages: [...room.system, { role: "user", content: leadOf(summary) }],
    tools: [...room.tools],
  });
  return tailBudget(room.window, room.reserve, base);
}

// the rows after the last done summary, with its tail when a room is
// given; the memory phase and the attention step read one run's rows,
// which never hold a summary, and pass none
export function historyMessages(
  rows: Message[],
  policy: RenderPolicy,
  lookups: ContextLookups,
  room: TailRoom | null = null,
): ChatMessageIn[] {
  const turns: ReadonlyMap<string, Turn> =
    rows.length === 0 ? new Map() : lookups.turnsOf(rows[0]!.sessionId);
  const cut = lastSummary(rows);
  if (cut < 0) return renderRows(rows, policy, lookups, turns);
  const tailAt = (at: number) =>
    tailOf(
      rows,
      at,
      room === null ? 0 : budgetAt(room, policy.model, rows[at]!),
      policy,
      lookups,
      turns,
      room?.wire ?? null,
    );
  const tail = tailAt(cut);
  const previous = lastSummary(rows, cut);
  const names = loadedSkills(
    rows,
    previous < 0 ? 0 : tailAt(previous).start,
    tail.start,
    cut,
    new Set(policy.offered.skills.skills.map((skill) => skill.name)),
    (sendId) => ownTurn(turns.get(sendId), policy),
  );
  const remembered =
    names.length === 0 ? "" : `\n\n${SKILLS_LEAD} ${names.join(", ")}`;
  // an upload inside the tail replays as its own block
  const uploads = rows
    .slice(0, tail.start)
    .some((row) => row.kind === "user" && row.uploads?.length)
    ? `\n\n${UPLOADS_SUMMARY_LINE}`
    : "";
  return [
    { role: "user", content: `${leadOf(rows[cut]!)}${remembered}${uploads}` },
    ...tail.messages,
    ...renderRows(rows.slice(cut + 1), policy, lookups, turns),
  ];
}

// a summoned agent keeps its own key, so two agents never share a
// router's sticky routing or a local engine's slot
export const cacheKeyOf = (
  policy: Pick<SendPolicy, "agentId" | "summoned">,
  sessionId: string,
): string =>
  policy.summoned === null ? sessionId : `${sessionId}:${policy.agentId}`;

export function request(
  policy: SendPolicy,
  sessionId: string,
  messages: ChatMessageIn[],
): ChatRequest {
  return {
    model: policy.model,
    messages,
    thinking: policy.thinking,
    thinkingOff: policy.thinkingOff,
    reasoningEffort: policy.effort,
    cacheKey: cacheKeyOf(policy, sessionId),
    upstream: policy.upstream,
    skip4Bit: policy.skip4Bit,
    ...(policy.offered.tools.length > 0 ? { tools: policy.offered.tools } : {}),
  };
}

// the room kept under the window past the summary request's estimate:
// another provider's tokenizer can count more, and a wire may replay
// reasoning the count leaves out (Azure's encrypted items), while a
// strict provider refuses prompt plus max_tokens past the window. The
// floor is the least a summary is asked for: a short summary beats
// none, and a provider that cannot fit even that refuses the round,
// which ends failed and is tried again next time
export const SUMMARY_MARGIN = 256;
export const SUMMARY_MARGIN_SHARE = 0.1;
export const SUMMARY_MIN_TOKENS = 128;

// the summary round: the history plus the instruction, no tools and the
// least thinking, since a model's thoughts come out of the same cap. Its
// answer is capped by the limit and the reserve, then fits an estimate
// of its own request: the answer round's usage carried the schemas and
// counts its completion on top
export function summaryRequest(
  policy: SendPolicy,
  sessionId: string,
  messages: ChatMessageIn[],
): ChatRequest {
  const window = policy.contextLength;
  const reserve =
    window === null
      ? policy.limits.summaryMaxTokens
      : contextReserve(window, policy.limits.contextReserve);
  const req: ChatRequest = {
    model: policy.model,
    messages: [...messages, { role: "user", content: SUMMARIZE }],
    ...leastThinking(policy),
    cacheKey: cacheKeyOf(policy, sessionId),
    upstream: policy.upstream,
    skip4Bit: policy.skip4Bit,
  };
  let maxTokens = Math.min(policy.limits.summaryMaxTokens, reserve);
  if (window !== null) {
    const margin = SUMMARY_MARGIN + Math.floor(window * SUMMARY_MARGIN_SHARE);
    const room = window - requestTokens(policy.wire, req) - margin;
    maxTokens = Math.max(SUMMARY_MIN_TOKENS, Math.min(maxTokens, room));
  }
  return { ...req, maxTokens };
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
