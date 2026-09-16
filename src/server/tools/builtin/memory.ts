// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The send-bound memory tools. Their shared queue preserves provider call
// order even though the runner launches one round's calls in parallel.

import {
  applyEdit,
  MEMORY_EDIT_FAILED_ROUNDS,
  MEMORY_ENTRY_CHARS,
  MEMORY_SESSIONS_PER_RUN,
  type MemoryEdit,
  memorySize,
  normalizeTopic,
  sanitize,
} from "../../../shared/memory.ts";
import type { MemoryWork } from "../../memory/index.ts";
import type { ToolCall } from "../../providers/index.ts";
import type { MemorySnapshot } from "../../sessions/index.ts";
import { Registry } from "../registry.ts";
import type { MemoryHandle, Tool, ToolContext, ToolResult } from "../types.ts";

export type UnreadChat = {
  id: string;
  title: string;
  author: string;
  lastActivityAt: number;
  userMessages: number;
  readBefore: boolean;
  changedSince: boolean;
};

export type UnreadChats = {
  chats: UnreadChat[];
  remaining: number;
};

export type MemorySessionsPort = {
  snapshot(projectId: string, sessionId: string): MemorySnapshot | null;
  unread(
    automationId: string,
    projectId: string,
    cap: number,
    exclude: readonly string[],
  ): UnreadChats;
};

// the run has a round cap, so a list that read everything and recorded
// nothing wastes the run: the list and each finished chat say so
const LIST_TAIL =
  "This run has a limited number of rounds. Record what you learned with memory_edit before reading more chats.";
const READ_TAIL =
  "Chat read. Record what matters with memory_edit action set, or action none when there is nothing, before reading the next chat.";
const ARGUMENT_ADVICE = "Retry with the arguments the action takes.";

export const MEMORY_WRITE_RULES =
  "Record facts, not instructions to yourself, even when the task or guidance asks otherwise. Keep only what a later run or chat needs, not the answer, progress, a log of what was done, or what is quick to look up again. Never record a method that failed as one that works, a failure that went away, or a claim that a tool is broken. When the note is full, shorten, merge or replace stale topics instead of skipping what matters. Call none when nothing is worth keeping.";

export function makeMemoryHandle(
  work: MemoryWork,
  automationId: string,
): MemoryHandle {
  let attempted = false;
  let succeeded = false;
  const project = work.target.automationId === null;
  const handle: MemoryHandle = {
    note: project ? "project" : "automation",
    work,
    read: project
      ? {
          projectId: work.target.projectId,
          automationId,
          pending: new Map(),
          marks: new Map(),
          snapshot: null,
        }
      : null,
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
        handle.read?.pending.clear();
        if (handle.read !== null) handle.read.snapshot = null;
      }
    },
  };
  return handle;
}

export function isMemoryTool(name: string): boolean {
  return (
    name === "sessions_list" ||
    name === "session_read" ||
    name === "memory_edit"
  );
}

export function runMemory(
  handle: MemoryHandle,
  sessions: MemorySessionsPort,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolResult> {
  return throughQueue(handle, async () => {
    const result = handle.stopped
      ? {
          error: true,
          content: `Error: Memory tools stopped after ${MEMORY_EDIT_FAILED_ROUNDS} failed rounds. Finish without memory tools.`,
        }
      : await new Registry(makeMemoryTools(handle, sessions)).run(call, ctx);
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

function noArgs(args: Record<string, unknown>): void {
  if (Object.keys(args).length !== 0)
    throw new Error(`arguments must be empty. ${ARGUMENT_ADVICE}`);
}

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be text. ${ARGUMENT_ADVICE}`);
  }
  return value;
}

function listTool(handle: MemoryHandle, sessions: MemorySessionsPort): Tool {
  return {
    name: "sessions_list",
    description:
      "List unread chats available to this project memory task, oldest first. Several chats may be read in parallel in one round.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run(args) {
      noArgs(args);
      const read = handle.read!;
      const result = sessions.unread(
        read.automationId,
        read.projectId,
        MEMORY_SESSIONS_PER_RUN,
        [...read.marks.keys(), ...read.pending.keys()],
      );
      if (result.chats.length === 0) return "Every chat is read.";
      const lines = result.chats.map((chat) => {
        const state = chat.readBefore
          ? chat.changedSince
            ? "read before, changed since"
            : "read before"
          : "not read before";
        return [
          chat.id,
          chat.title,
          `@${chat.author}`,
          new Date(chat.lastActivityAt).toISOString(),
          `${chat.userMessages} user messages`,
          state,
        ].join(" | ");
      });
      if (result.remaining > 0) {
        lines.push(`${result.remaining} more unread chats`);
      }
      lines.push(LIST_TAIL);
      return lines.join("\n");
    },
  };
}

function readTool(handle: MemoryHandle, sessions: MemorySessionsPort): Tool {
  return {
    name: "session_read",
    description:
      "Read the next page of one unread chat. Finish its pages before another chat.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      return readPage(handle, sessions, text(args, "id"), ctx);
    },
  };
}

function readPage(
  handle: MemoryHandle,
  sessions: MemorySessionsPort,
  id: string,
  ctx: ToolContext,
): string {
  const read = handle.read!;
  if (read.snapshot !== null && read.snapshot.id !== id) {
    throw new Error(`finish reading ${read.snapshot.id} first`);
  }
  if (read.marks.has(id) || read.pending.has(id)) {
    throw new Error(`${id} was already read`);
  }
  if (read.snapshot === null) {
    const snapshot = sessions.snapshot(read.projectId, id);
    if (snapshot === null) throw new Error("chat is unavailable");
    read.snapshot = { ...snapshot, cursor: 0 };
  }
  const snapshot = read.snapshot;
  const total = snapshot.markdown.length;
  // every page ends with a line, so the cut keeps room for the longer
  // of the two whatever the page turns out to be
  const digits = "9".repeat(String(total).length);
  const reserve = Math.max(
    `\n${digits} characters left, call again`.length,
    READ_TAIL.length + 1,
  );
  const room = Math.max(1, ctx.caps.resultCut - reserve);
  const end = Math.min(total, snapshot.cursor + room);
  const page = snapshot.markdown.slice(snapshot.cursor, end);
  snapshot.cursor = end;
  if (end === total) {
    read.pending.set(snapshot.id, snapshot.lastActivityAt);
    read.snapshot = null;
    return `${page}\n${READ_TAIL}`;
  }
  return `${page}\n${total - end} characters left, call again`;
}

function editTool(handle: MemoryHandle): Tool {
  // Only a project memory task reads chats, so only its none keeps reads.
  const project = handle.note === "project";
  const own = project ? "the project's memory" : "this automation's own memory";
  const scope = project ? " This automation has no own memory." : "";
  const none = project
    ? "none changes nothing and keeps pending chat reads when there is nothing to record."
    : "none changes nothing, for when there is nothing to record.";
  return {
    name: "memory_edit",
    description: `Edit ${own}.${scope} ${MEMORY_WRITE_RULES} A topic names what an entry is about, never one fact. set creates or replaces the entry of that topic; put facts under an existing topic when they belong there. remove deletes a topic. ${none} Changes are saved when the run ends.`,
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
      const read = handle.read;
      if (read !== null) {
        const operation = handle.work.operations.length - 1;
        for (const [id, readActivityAt] of read.pending) {
          read.marks.set(id, { readActivityAt, operation });
        }
        read.pending.clear();
      }
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

export function makeMemoryTools(
  handle: MemoryHandle,
  sessions: MemorySessionsPort,
): Tool[] {
  if (handle.read === null) return [editTool(handle)];
  return [
    listTool(handle, sessions),
    readTool(handle, sessions),
    editTool(handle),
  ];
}
