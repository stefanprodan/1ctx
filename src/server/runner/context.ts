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
// user message, never a stored row. Another agent's turn in the chat
// goes as its answer and its trace, never its calls, results or
// reasoning. Tested on fixtures, malformed histories among them.

import { contextReserve } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { toolArguments } from "../../shared/contracts/tool.ts";
import { UPLOADS_SUMMARY_LINE, uploadsBlock } from "../../shared/uploads.ts";
import { EFFORTS, type Effort, type Wire } from "../../shared/words.ts";
import { tokens } from "../lib/tokens.ts";
import type {
  ChatMessageIn,
  ChatRequest,
  ReasoningDetail,
  ToolCall,
} from "../providers/index.ts";
import type { SendPolicy } from "./policy.ts";
import { NO_REPO_LINES, type RepoLines, systemPrompt } from "./prompt.ts";
import { trace, traceCalls, type Yours, yoursOf } from "./trace.ts";

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

// who answered a send of the session: its agent and whether it was
// summoned for the turn
export type Turn = { agentId: string; agentName: string; summoned: boolean };

export type ContextLookups = {
  // the author's username, for the name field on the wire
  usernameOf(userId: string): string | null;
  reasoningDetailsOf(
    messageId: string,
    providerId: string,
    model: string,
  ): ReasoningDetail[] | null;
  // the session's sends by id
  turnsOf(sessionId: string): ReadonlyMap<string, Turn>;
};

type Builder = Pick<SendPolicy, "agentId" | "summoned">;

// a turn is the building agent's own when neither is summoned (a fork's
// copied turns included) or both are summoned sends of the same agent;
// a send the lookup does not know is its own
function ownTurn(turn: Turn | undefined, policy: Builder): boolean {
  if (turn === undefined) return true;
  return policy.summoned === null
    ? !turn.summoned
    : turn.summoned && turn.agentId === policy.agentId;
}

// the mark that opens another agent's answer in a history
const markOf = (name: string) => `[${name}] `;

// an answer without the agent's own mark: a model that read other
// agents' marked answers may open its own the same way. Only a mark
// followed by a space or the end, so a link or reference that opens
// with the name stays; names are lowercase but a model's case is not
export function unmarked(text: string, name: string): string {
  const mark = markOf(name).trimEnd().toLowerCase();
  const start = text.trimStart();
  if (start.slice(0, mark.length).toLowerCase() !== mark) return text;
  const rest = start.slice(mark.length);
  return rest === "" || /^\s/.test(rest) ? rest.trimStart() : text;
}

// another agent's turn: its answer as a user message opened by its
// name, with no author field, then its trace as its own message, the
// calls to tools the building agent lacks marked
function foreignTurn(
  turn: Turn,
  rows: readonly Message[],
  yours: Yours,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [];
  const answer = rows
    .filter(
      (row) =>
        row.kind === "reply" &&
        row.slot !== "work" &&
        row.status !== "streaming" &&
        row.content !== "",
    )
    .map((row) => row.content)
    .join("\n\n");
  if (answer !== "") {
    out.push({ role: "user", content: `${markOf(turn.agentName)}${answer}` });
  }
  const calls = trace(traceCalls(rows), yours);
  if (calls !== "") out.push({ role: "user", content: calls });
  return out;
}

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
  // the skill was loaded by the building agent itself
  own: (sendId: string) => boolean,
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
    if (typeof name === "string" && offered.has(name) && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

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
  >,
  lookups: ContextLookups,
  now: number,
  mcpNote = "",
  repos: RepoLines = NO_REPO_LINES,
): ChatMessageIn[] {
  return [
    { role: "system", content: systemPrompt(policy, now, mcpNote, repos) },
    ...historyMessages(rows, policy, lookups),
  ];
}

export function historyMessages(
  rows: Message[],
  policy: Pick<
    SendPolicy,
    | "username"
    | "userId"
    | "providerId"
    | "model"
    | "offered"
    | "agentId"
    | "summoned"
  >,
  lookups: ContextLookups,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [];
  const turns =
    rows.length === 0
      ? new Map<string, Turn>()
      : lookups.turnsOf(rows[0]!.sessionId);
  const own = (sendId: string) => ownTurn(turns.get(sendId), policy);
  const yours = yoursOf(policy.offered);
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "summary" && row.status === "done") {
      const names = loadedSkills(
        rows,
        i,
        new Set(policy.offered.skills.skills.map((skill) => skill.name)),
        own,
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
  // another agent's rows of one send, sent as its answer and trace once
  // the send's rows end
  let foreign: Message[] = [];
  const flush = () => {
    const first = foreign[0];
    if (first !== undefined) {
      out.push(...foreignTurn(turns.get(first.sendId)!, foreign, yours));
    }
    foreign = [];
  };
  for (const row of active) {
    if (foreign.length > 0 && row.sendId !== foreign[0]!.sendId) flush();
    if (row.kind === "summary") continue;
    if (row.kind !== "user" && !own(row.sendId)) {
      foreign.push(row);
      continue;
    }
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
  flush();
  return out;
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
    cacheKey: cacheKeyOf(policy, sessionId),
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
