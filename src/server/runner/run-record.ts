// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The record of a run that a step after it reads in place of the run's
// history: how the run ended, the task, the answer and a receipt per
// tool call with the start of its result. Fetched pages would cost a
// local model tens of seconds before its first token and a step needs
// only what each call came back as. The memory phase and the attention
// step each wrap it in their own prompt. Pure, over the rows and a token
// count.
//
// The run is given as a record inside tags, under a system prompt of the
// step's own: a model that reads the task again under the run's prompt
// goes back to the task, fetching with tools it no longer has and
// writing the answer again.

import { contextReserve } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import type { SendCause, Wire } from "../../shared/words.ts";
import {
  type ChatMessageIn,
  type ChatTool,
  sentMessages,
  wireTools,
} from "../providers/index.ts";

// These caps bound provider input, not any stored text.
export const RECORD_ANSWER_CHARS = 8000;
export const RECORD_RECEIPTS_CHARS = 8000;
export const RECORD_EXCERPT_CHARS = 400;
const RECORD_ARGUMENT_CHARS = 400;

// the run's rows are those of its send before the step's first round
export type RecordInput = {
  sendId: string;
  before: number;
  cause: SendCause;
  error: string | null;
  rows: readonly Message[];
};

type Receipt = { line: string; excerpt: string };

export type RecordParts = {
  cause: SendCause;
  error: string | null;
  task: string;
  answer: string;
  answerLabel: string;
  items: Receipt[];
};

// the request the record is fitted into
export type RecordContext = {
  // the wire and model the step is sent to, so the fit counts the
  // step's past reasoning only where the wire sends it back
  wire: Wire | null;
  model: string;
  tools: ChatTool[];
  contextLength: number | null;
  reserve: number;
};

export function cut(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const last = text.charCodeAt(chars - 1);
  if (last >= 0xd800 && last <= 0xdbff) chars--;
  return text.slice(0, chars);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function receipts(rows: readonly Message[]): Receipt[] {
  const tools = new Map<number, Message[]>();
  for (const row of rows) {
    if (row.kind !== "tool") continue;
    const group = tools.get(row.round) ?? [];
    group.push(row);
    tools.set(row.round, group);
  }
  return rows.flatMap((row) => {
    if (row.kind !== "reply") return [];
    return (row.toolCalls ?? []).map((call, index) => {
      // Position keeps duplicate call ids distinct, as the writer does.
      const result = tools.get(row.round)?.[index];
      const paired = result?.toolCallId === call.id ? result : undefined;
      const name = paired?.toolName ?? call.name;
      const args = cut(oneLine(call.arguments), RECORD_ARGUMENT_CHARS);
      const done = paired?.status === "done";
      const outcome = done
        ? `done (${new TextEncoder().encode(paired.content).byteLength} bytes)`
        : `failed: ${oneLine(
            paired?.error ||
              paired?.content ||
              "not run: no result was recorded",
          )}`;
      return {
        line: cut(`- ${name} ${args}: ${outcome}`, RECORD_RECEIPTS_CHARS),
        excerpt: done ? cut(paired.content, RECORD_EXCERPT_CHARS) : "",
      };
    });
  });
}

function receiptText(receipt: Receipt): string {
  return cut(
    receipt.excerpt === ""
      ? receipt.line
      : `${receipt.line}\n  Excerpt: ${receipt.excerpt}`,
    RECORD_RECEIPTS_CHARS,
  );
}

function lastReceipts(items: Receipt[]): Receipt[] {
  let chars = 0;
  let start = items.length;
  while (start > 0) {
    const size = receiptText(items[start - 1]!).length;
    const next = chars + size + (chars === 0 ? 0 : 2);
    if (next > RECORD_RECEIPTS_CHARS) break;
    chars = next;
    start--;
  }
  return items.slice(start);
}

// a closing tag inside the record would end it early
function fenced(tag: string, text: string): string {
  const body = text.replace(new RegExp(`<(?=\\s*/?\\s*${tag}\\b)`, "gi"), "‹");
  return `<${tag}>\n${body}\n</${tag}>`;
}

export function recordParts(input: RecordInput): RecordParts {
  const rows = input.rows.filter(
    (row) => row.sendId === input.sendId && row.round < input.before,
  );
  const task = rows.find((row) => row.kind === "user");
  if (task === undefined) throw new Error("the run has no task message");
  const replies = rows.filter(
    (row) => row.kind === "reply" && row.content.trim() !== "",
  );
  const answerRow =
    replies.findLast((row) => row.slot === "answer") ??
    replies.findLast((row) => row.slot === "work");
  return {
    cause: input.cause,
    error: input.error,
    task: task.content,
    answer: cut(answerRow?.content ?? "", RECORD_ANSWER_CHARS),
    answerLabel:
      answerRow?.slot === "answer" ? "Run's answer" : "Last work text",
    items: lastReceipts(receipts(rows)),
  };
}

// the record's sections, each to be joined with a blank line
export function recordSections(parts: RecordParts): string[] {
  const ending =
    parts.cause === "deadline"
      ? "The run was cut by its deadline."
      : parts.cause === "failure"
        ? `The run failed${parts.error === null ? "." : `: ${parts.error}`}`
        : "The run finished.";
  return [
    `${ending}\nWhat follows is the record of the run, to read, not to do again.`,
    `The run was asked:\n${fenced("task", parts.task)}`,
    ...(parts.answer === ""
      ? []
      : [`${parts.answerLabel}:\n${fenced("answer", parts.answer)}`]),
    ...(parts.items.length === 0
      ? []
      : [
          `The run's tool calls:\n${fenced("tool_calls", parts.items.map(receiptText).join("\n\n"))}`,
        ]),
  ];
}

// the messages built over the record, shortened until they fit the
// window: the excerpts go first, then the oldest receipts, then the
// answer is halved; null when even that does not fit
export function fitRecord(
  parts: RecordParts,
  build: (parts: RecordParts) => ChatMessageIn[],
  context: RecordContext,
  count: (text: string) => number,
): ChatMessageIn[] | null {
  if (context.contextLength === null) return build(parts);
  const room =
    context.contextLength -
    contextReserve(context.contextLength, context.reserve);
  const schemas = wireTools(context.tools);
  const fits = (messages: ChatMessageIn[]) =>
    count(
      JSON.stringify({
        messages: sentMessages(context.wire, context.model, messages),
        tools: schemas,
      }),
    ) <= room;
  let current = parts;
  let messages = build(current);
  if (fits(messages)) return messages;
  current = {
    ...current,
    items: current.items.map((item) => ({ ...item, excerpt: "" })),
  };
  messages = build(current);
  if (fits(messages)) return messages;
  while (current.items.length > 0) {
    current = { ...current, items: current.items.slice(1) };
    messages = build(current);
    if (fits(messages)) return messages;
  }
  // Recount each shorter prefix: character counts are not token counts.
  while (current.answer.length > 0) {
    current = {
      ...current,
      answer: cut(current.answer, Math.floor(current.answer.length / 2)),
    };
    messages = build(current);
    if (fits(messages)) return messages;
  }
  return null;
}
