// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A record under the step's own prompt, so the model does not redo the task.

import { contextReserve } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { cutAt, oneLine } from "../../shared/text.ts";
import type { SendCause, Wire } from "../../shared/words.ts";
import {
  type ChatMessageIn,
  type ChatTool,
  requestText,
} from "../providers/index.ts";
import { roundKey, toolRowsByRound } from "./trace.ts";

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
  // request in the wire's shape, past reasoning only where it goes back
  wire: Wire | null;
  model: string;
  tools: ChatTool[];
  contextLength: number | null;
  reserve: number;
};

function receipts(rows: readonly Message[]): Receipt[] {
  const tools = toolRowsByRound(rows);
  return rows.flatMap((row) => {
    if (row.kind !== "reply") return [];
    return (row.toolCalls ?? []).map((call, index) => {
      // Position keeps duplicate call ids distinct, as the writer does.
      const result = tools.get(roundKey(row))?.[index];
      const paired = result?.toolCallId === call.id ? result : undefined;
      const name = paired?.toolName ?? call.name;
      const args = cutAt(oneLine(call.arguments), RECORD_ARGUMENT_CHARS);
      const done = paired?.status === "done";
      const outcome = done
        ? `done (${new TextEncoder().encode(paired.content).byteLength} bytes)`
        : `failed: ${oneLine(
            paired?.error ||
              paired?.content ||
              "not run: no result was recorded",
          )}`;
      return {
        line: cutAt(`- ${name} ${args}: ${outcome}`, RECORD_RECEIPTS_CHARS),
        excerpt: done ? cutAt(paired.content, RECORD_EXCERPT_CHARS) : "",
      };
    });
  });
}

function receiptText(receipt: Receipt): string {
  return cutAt(
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
    answer: cutAt(answerRow?.content ?? "", RECORD_ANSWER_CHARS),
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
  const fits = (messages: ChatMessageIn[]) =>
    count(
      requestText(context.wire, {
        model: context.model,
        messages,
        thinking: false,
        tools: context.tools,
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
      answer: cutAt(current.answer, Math.floor(current.answer.length / 2)),
    };
    messages = build(current);
    if (fits(messages)) return messages;
  }
  return null;
}
