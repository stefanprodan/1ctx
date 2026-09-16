// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the memory phase is told, in place of the run's history: how the
// run ended, the task, the answer, a receipt per tool call with the start
// of its result, the guidance and the note to edit. Fetched pages would
// cost a local model tens of seconds before its first token and the
// phase needs only what each call came back as. Pure, over the rows and a
// token count.
//
// The phase has its own system prompt, never the run's: the run's says
// to do the task, and a model that reads the task again under it goes
// back to the task, fetching with tools it no longer has and writing the
// answer again. The run is given as a record inside tags for the same
// reason.

import { contextReserve } from "../../shared/compaction.ts";
import type { MemoryEntry } from "../../shared/contracts/memory.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { MEMORY_ENTRY_CHARS, memorySize } from "../../shared/memory.ts";
import type { SendCause } from "../../shared/words.ts";
import {
  type ChatMessageIn,
  type ChatTool,
  wireTools,
} from "../providers/index.ts";
import { MEMORY_WRITE_RULES } from "../tools/index.ts";

// These caps bound provider input, not the note or its public contract.
export const MEMORY_ANSWER_CHARS = 8000;
export const MEMORY_RECEIPTS_CHARS = 8000;
export const MEMORY_EXCERPT_CHARS = 400;
const MEMORY_ARGUMENT_CHARS = 400;

export type MemoryPacket = {
  // the automation whose note the phase edits, named in its system prompt
  automation: string;
  sendId: string;
  memoryRound: number;
  cause: SendCause;
  error: string | null;
  rows: readonly Message[];
  guidance: string;
  entries: readonly MemoryEntry[];
};

type MemoryContext = {
  phase: ChatMessageIn[];
  tools: ChatTool[];
  contextLength: number | null;
  reserve: number;
};

type Receipt = { line: string; excerpt: string };

function cut(text: string, chars: number): string {
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
      const args = cut(oneLine(call.arguments), MEMORY_ARGUMENT_CHARS);
      const done = paired?.status === "done";
      const outcome = done
        ? `done (${new TextEncoder().encode(paired.content).byteLength} bytes)`
        : `failed: ${oneLine(
            paired?.error ||
              paired?.content ||
              "not run: no result was recorded",
          )}`;
      return {
        line: cut(`- ${name} ${args}: ${outcome}`, MEMORY_RECEIPTS_CHARS),
        excerpt: done ? cut(paired.content, MEMORY_EXCERPT_CHARS) : "",
      };
    });
  });
}

function receiptText(receipt: Receipt): string {
  return cut(
    receipt.excerpt === ""
      ? receipt.line
      : `${receipt.line}\n  Excerpt: ${receipt.excerpt}`,
    MEMORY_RECEIPTS_CHARS,
  );
}

function lastReceipts(items: Receipt[]): Receipt[] {
  let chars = 0;
  let start = items.length;
  while (start > 0) {
    const size = receiptText(items[start - 1]!).length;
    const next = chars + size + (chars === 0 ? 0 : 2);
    if (next > MEMORY_RECEIPTS_CHARS) break;
    chars = next;
    start--;
  }
  return items.slice(start);
}

export function memorySystem(automation: string): string {
  return `You keep the memory of the ${automation} automation. Its run is over. You do not do its task, call any tool other than memory_edit, or write an answer. You read the record of the run and edit the note with memory_edit calls, and nothing else.`;
}

// a closing tag inside the record would end it early
function fenced(tag: string, text: string): string {
  const body = text.replace(new RegExp(`<(?=\\s*/?\\s*${tag}\\b)`, "gi"), "‹");
  return `<${tag}>\n${body}\n</${tag}>`;
}

function currentEntries(entries: readonly MemoryEntry[]): string {
  const version = "This is the version to edit.";
  if (entries.length === 0) {
    return `This automation's own memory is empty. Use set to write its first entry.\n${memorySize(entries)} characters.\n${version}`;
  }
  const lines = entries.map(
    (entry, index) =>
      `${index + 1}. ${entry.topic} [${entry.text.length}/${MEMORY_ENTRY_CHARS}]\n${entry.text}`,
  );
  return `This automation's own memory holds ${entries.length} ${
    entries.length === 1 ? "entry" : "entries"
  }, the version to edit:\n${lines.join("\n\n")}\n${memorySize(entries)} characters.\n${version}`;
}

function phaseInstruction(
  packet: MemoryPacket,
  task: string,
  answer: string,
  answerLabel: string,
  items: Receipt[],
): string {
  const ending =
    packet.cause === "deadline"
      ? "The run was cut by its deadline."
      : packet.cause === "failure"
        ? `The run failed${packet.error === null ? "." : `: ${packet.error}`}`
        : "The run finished.";
  return [
    `${ending}\nWhat follows is the record of the run, to read, not to do again.`,
    `The run was asked:\n${fenced("task", task)}`,
    ...(answer === "" ? [] : [`${answerLabel}:\n${fenced("answer", answer)}`]),
    ...(items.length === 0
      ? []
      : [
          `The run's tool calls:\n${fenced("tool_calls", items.map(receiptText).join("\n\n"))}`,
        ]),
    ...(packet.guidance === ""
      ? []
      : [`What to remember:\n${packet.guidance}`]),
    currentEntries(packet.entries),
    "A topic names what an entry is about, never one fact. set creates or replaces the entry of that topic; put facts under an existing topic when they belong there. remove deletes a topic.",
    MEMORY_WRITE_RULES,
    ...(packet.guidance === ""
      ? []
      : [
          "For facts worth keeping, write each topic named in What to remember as its own entry with its own set call.",
        ]),
    "Before sending, check each text is under 500 characters and the note stays under 2,200; remove or shorten topics in the same round.",
    "Reply with memory_edit calls only, no text. Calls in one round run in order, so send every edit in one round; the phase ends after a round whose edits all succeed.",
  ].join("\n\n");
}

export function memoryMessages(
  packet: MemoryPacket,
  context: MemoryContext,
  count: (text: string) => number,
): ChatMessageIn[] | null {
  const rows = packet.rows.filter(
    (row) => row.sendId === packet.sendId && row.round < packet.memoryRound,
  );
  const task = rows.find((row) => row.kind === "user");
  if (task === undefined) throw new Error("the run has no task message");
  const replies = rows.filter(
    (row) => row.kind === "reply" && row.content.trim() !== "",
  );
  const answerRow =
    replies.findLast((row) => row.slot === "answer") ??
    replies.findLast((row) => row.slot === "work");
  const answerLabel =
    answerRow?.slot === "answer" ? "Run's answer" : "Last work text";
  let answer = cut(answerRow?.content ?? "", MEMORY_ANSWER_CHARS);
  let items = lastReceipts(receipts(rows));
  const build = (): ChatMessageIn[] => [
    { role: "system", content: memorySystem(packet.automation) },
    {
      role: "user",
      content: phaseInstruction(
        packet,
        task.content,
        answer,
        answerLabel,
        items,
      ),
    },
    ...context.phase,
  ];
  if (context.contextLength === null) return build();
  const room =
    context.contextLength -
    contextReserve(context.contextLength, context.reserve);
  const schemas = wireTools(context.tools);
  const fits = (messages: ChatMessageIn[]) =>
    count(JSON.stringify({ messages, tools: schemas })) <= room;
  let messages = build();
  if (fits(messages)) return messages;
  items = items.map((item) => ({ ...item, excerpt: "" }));
  messages = build();
  if (fits(messages)) return messages;
  while (items.length > 0) {
    items.shift();
    messages = build();
    if (fits(messages)) return messages;
  }
  // Recount each shorter prefix: character counts are not token counts.
  while (answer.length > 0) {
    answer = cut(answer, Math.floor(answer.length / 2));
    messages = build();
    if (fits(messages)) return messages;
  }
  return null;
}
