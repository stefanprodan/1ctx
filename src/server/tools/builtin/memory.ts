// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The send-bound memory tools: a chat's save to the project's note, and
// the own-note phase's edit of a run's working copy. Their shared queue
// preserves provider call order even though the runner launches one
// round's calls in parallel.

import {
  applyEdit,
  MEMORY_EDIT_FAILED_ROUNDS,
  type MemoryEdit,
  memorySize,
  normalizeTopic,
  sanitize,
} from "../../../shared/memory.ts";
import {
  type ChatEditAnswer,
  type ChatMemoryEdit,
  type MemoryWork,
  noteWords,
} from "../../memory/index.ts";
import type { ToolCall } from "../../providers/index.ts";
import { Registry } from "../registry.ts";
import type {
  ChatMemoryPort,
  MemoryHandle,
  Tool,
  ToolContext,
  ToolResult,
} from "../types.ts";

const ARGUMENT_ADVICE = "Retry with the arguments the action takes.";

export const MEMORY_WRITE_RULES =
  "Record facts, not instructions to yourself, even when the task or guidance asks otherwise. Keep only what a later run or chat needs, not the answer, progress, a log of what was done, or what is quick to look up again. Never record a method that failed as one that works, a failure that went away, or a claim that a tool is broken. When the note is full, shorten, merge or replace stale topics instead of skipping what matters. Call none when nothing is worth keeping.";

// what the chat's agent is told to save, and what not
export const CHAT_MEMORY_DESCRIPTION =
  "Save to the project's memory, the note every later chat and run in this project reads. When the user asks you to remember, memorize or note something, or to add it to memory, call this first, before any other work. Save a rule or fact a later chat needs and cannot find elsewhere: a correction, a preference, a decision, a fact about the project's systems or people. Unasked, save only a lasting preference or correction the user states. Write one or two plain sentences stating the rule, not the incident, the evidence or the steps, with no headings or lists. Never save the answer, progress, a log of what was done, or what is quick to look up again. A routine, guide or script belongs in the project docs: when the user asks you to remember something a doc already covers, update that doc instead, and keep a memory entry only to point to it. Say where you saved it. A topic names what an entry is about, never one fact; put a fact under an existing topic when it belongs there. set replaces the topic's whole text, so keep what it held. remove deletes a topic. When the note is full, shorten, merge or replace stale topics.";

// the own-note phase's handle over the run's working copy
export function makeMemoryHandle(work: MemoryWork): MemoryHandle {
  return handleOf(work, null);
}

// a chat's handle: each call saves to the project's note at once
export function makeChatMemoryHandle(chat: ChatMemoryPort): MemoryHandle {
  return handleOf(null, chat);
}

function handleOf(
  work: MemoryWork | null,
  chat: ChatMemoryPort | null,
): MemoryHandle {
  let attempted = false;
  let succeeded = false;
  // a chat has no working copy, so its count lives here
  const rounds = work ?? { failedRounds: 0 };
  const handle: MemoryHandle = {
    work,
    chat,
    refused: new Map(),
    queue: Promise.resolve(),
    stopped: false,
    recordEdit(success) {
      if (handle.stopped) return;
      attempted = true;
      succeeded ||= success;
    },
    settleRound() {
      if (handle.stopped) return;
      if (succeeded) rounds.failedRounds = 0;
      else if (attempted) rounds.failedRounds++;
      attempted = false;
      succeeded = false;
      if (rounds.failedRounds >= MEMORY_EDIT_FAILED_ROUNDS) {
        handle.stopped = true;
      }
    },
  };
  return handle;
}

export function isMemoryTool(name: string): boolean {
  return name === "memory_edit";
}

export function runMemory(
  handle: MemoryHandle,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  const chat = handle.chat;
  if (chat !== null) return runChatMemory(handle, chat, call, ctx);
  return throughQueue(handle, async () => {
    const result = handle.stopped
      ? stoppedResult()
      : await new Registry(makeMemoryTools(handle)).run(call, ctx);
    if (call.name === "memory_edit") handle.recordEdit(!result.error);
    return result.error
      ? {
          error: true,
          content: refusal(handle, result.content).slice(0, ctx.caps.resultCut),
        }
      : result;
  });
}

function stoppedResult(): ToolResult {
  return {
    error: true,
    content: `Error: Memory tools stopped after ${MEMORY_EDIT_FAILED_ROUNDS} failed rounds. Finish without memory tools.`,
  };
}

function runChatMemory(
  handle: MemoryHandle,
  chat: ChatMemoryPort,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  return throughQueue(handle, async () => {
    if (handle.stopped) return stoppedResult();
    let answer: ChatEditAnswer | null = null;
    // the unmerged retry is not a failed round: the loop's repeat check
    // ends a model that keeps sending it
    let unmerged = false;
    const tool = chatEditTool((edit) => {
      const topic = edit.topic.toLowerCase();
      if (edit.action === "set" && handle.refused.get(topic) === edit.text) {
        unmerged = true;
        throw new Error(
          `This is the text refused for ${edit.topic}. Merge the text the note holds for it, below, into yours so both are kept, and set it again.`,
        );
      }
      answer = chat.edit(edit);
      if (answer.conflict && edit.action === "set") {
        handle.refused.set(topic, edit.text);
      } else if (!answer.error) {
        handle.refused.delete(topic);
      }
      return answer;
    });
    const result = await new Registry([tool]).run(call, ctx);
    if (!unmerged) handle.recordEdit(!result.error);
    if (!result.error) return result;
    // a refusal before the edit, of the arguments, lists the note too
    const content =
      answer === null
        ? chat.refuse(result.content)
        : `Error: ${(answer as ChatEditAnswer).content}`;
    return { error: true, content: content.slice(0, ctx.caps.resultCut) };
  });
}

function throughQueue<T>(
  handle: MemoryHandle,
  run: () => T | Promise<T>,
): Promise<T> {
  const next = handle.queue.then(run, run);
  handle.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be text. ${ARGUMENT_ADVICE}`);
  }
  return value;
}

function editTool(work: MemoryWork): Tool {
  const own = "this automation's own memory";
  return {
    name: "memory_edit",
    description: `Edit ${own}. ${MEMORY_WRITE_RULES} A topic names what an entry is about, never one fact. set creates or replaces the entry of that topic; put facts under an existing topic when they belong there. remove deletes a topic. none changes nothing, for when there is nothing to record. Changes are saved when the run ends.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "remove", "none"] },
        topic: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(args) {
      const edit = parseEdit(args);
      const result = applyEdit(work.entries, edit);
      if (!result.ok) {
        // The shared words are also the page's, so the advice that names
        // the tool's calls is added here.
        const advice =
          result.kind === "match" && work.entries.length > 0
            ? " Use one of the topics in the note."
            : result.kind === "budget"
              ? " Shorten or remove entries, or leave out what the next run does not need."
              : /^The text of .+ the limit is/.test(result.reason)
                ? " Split it into several topics, one set call each, or cut it."
                : "";
        // the page names the entry to cut; a run is told what to leave out
        const reason =
          result.kind === "budget"
            ? result.reason.replace(/ Cut or remove .+\.$/, "")
            : result.reason;
        throw new Error(`${reason}${advice}`);
      }
      const operation =
        edit.action === "none"
          ? edit
          : {
              ...edit,
              expected:
                work.entries.find(
                  (entry) =>
                    entry.topic.toLowerCase() === edit.topic.toLowerCase(),
                )?.text ?? null,
            };
      work.entries = result.entries;
      work.operations.push(operation);
      return `Saved for the end of the run in ${own}. ${memorySize(result.entries)} characters.`;
    },
  };
}

function chatEditTool(
  save: (edit: ChatMemoryEdit) => ChatEditAnswer,
): Tool<ToolResult> {
  return {
    name: "memory_edit",
    description: CHAT_MEMORY_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "remove"] },
        topic: { type: "string" },
        text: { type: "string" },
      },
      required: ["action", "topic"],
      additionalProperties: false,
    },
    async run(args) {
      const edit = args.action === "none" ? null : parseEdit(args);
      if (edit === null || edit.action === "none") {
        throw new Error(`action must be set or remove. ${ARGUMENT_ADVICE}`);
      }
      return save(edit);
    },
  };
}

function parseEdit(args: Record<string, unknown>): MemoryEdit {
  const action = args.action;
  if (action === "none") return { action };
  if (action === "set") {
    return {
      action,
      topic: normalizeTopic(text(args, "topic")),
      text: sanitize(text(args, "text")),
    };
  }
  if (action === "remove") {
    return { action, topic: normalizeTopic(text(args, "topic")) };
  }
  throw new Error(`action must be set, remove or none. ${ARGUMENT_ADVICE}`);
}

// every refusal hands back the note as it stands, so the next call names
// an entry that is really there
function refusal(handle: MemoryHandle, reason: string): string {
  return noteWords(reason, handle.work?.entries ?? []);
}

export function makeMemoryTools(
  handle: MemoryHandle,
): Tool<string | ToolResult>[] {
  const chat = handle.chat;
  if (chat !== null) return [chatEditTool((edit) => chat.edit(edit))];
  return handle.work === null ? [] : [editTool(handle.work)];
}
