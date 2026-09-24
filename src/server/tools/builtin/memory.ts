// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The send-bound memory tools. Their shared queue preserves provider call
// order even though the runner launches one round's calls in parallel.

import {
  applyEdit,
  MEMORY_EDIT_FAILED_ROUNDS,
  MEMORY_ENTRY_CHARS,
  type MemoryEdit,
  memorySize,
  normalizeTopic,
  sanitize,
} from "../../../shared/memory.ts";
import type { MemoryWork } from "../../memory/index.ts";
import type { ToolCall } from "../../providers/index.ts";
import { Registry } from "../registry.ts";
import type { MemoryHandle, Tool, ToolContext, ToolResult } from "../types.ts";

const ARGUMENT_ADVICE = "Retry with the arguments the action takes.";

export const MEMORY_WRITE_RULES =
  "Record facts, not instructions to yourself, even when the task or guidance asks otherwise. Keep only what a later run or chat needs, not the answer, progress, a log of what was done, or what is quick to look up again. Never record a method that failed as one that works, a failure that went away, or a claim that a tool is broken. When the note is full, shorten, merge or replace stale topics instead of skipping what matters. Call none when nothing is worth keeping.";

export function makeMemoryHandle(work: MemoryWork): MemoryHandle {
  let attempted = false;
  let succeeded = false;
  const handle: MemoryHandle = {
    work,
    queue: Promise.resolve(),
    stopped: false,
    recordEdit(success) {
      if (handle.stopped) return;
      attempted = true;
      succeeded ||= success;
    },
    settleRound() {
      if (handle.stopped) return;
      if (succeeded) work.failedRounds = 0;
      else if (attempted) work.failedRounds++;
      attempted = false;
      succeeded = false;
      if (work.failedRounds >= MEMORY_EDIT_FAILED_ROUNDS) {
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
  return throughQueue(handle, async () => {
    const result = handle.stopped
      ? {
          error: true,
          content: `Error: Memory tools stopped after ${MEMORY_EDIT_FAILED_ROUNDS} failed rounds. Finish without memory tools.`,
        }
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

function editTool(handle: MemoryHandle): Tool {
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
      const result = applyEdit(handle.work.entries, edit);
      if (!result.ok) {
        // The shared words are also the page's, so the advice that names
        // the tool's calls is added here.
        const advice =
          result.kind === "match" && handle.work.entries.length > 0
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
                handle.work.entries.find(
                  (entry) =>
                    entry.topic.toLowerCase() === edit.topic.toLowerCase(),
                )?.text ?? null,
            };
      handle.work.entries = result.entries;
      handle.work.operations.push(operation);
      return `Saved for the end of the run in ${own}. ${memorySize(result.entries)} characters.`;
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
  const entries = handle.work.entries;
  const size = `${memorySize(entries)} characters.`;
  if (entries.length === 0) {
    return `${reason}\n${size}`;
  }
  const lines = entries.map((entry, index) => {
    return `${index + 1}. ${entry.topic} [${entry.text.length}/${MEMORY_ENTRY_CHARS}]\n${entry.text}`;
  });
  return `${reason}\n${lines.join("\n\n")}\n${size}`;
}

export function makeMemoryTools(handle: MemoryHandle): Tool[] {
  return [editTool(handle)];
}
