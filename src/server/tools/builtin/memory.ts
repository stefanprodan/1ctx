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
  "Chat read. Record what matters with memory_edit, or call it with action none when there is nothing, before reading the next chat.";

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
    throw new Error("arguments must be empty");
}

function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be text`);
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

// what the tool says it edits, and what it says it leaves alone: a
// memory task's prompt carries both notes and the tool has no target
function notes(handle: MemoryHandle): { own: string; other: string } {
  return handle.note === "project"
    ? {
        own: "the project's memory",
        other: "this automation's own memory",
      }
    : {
        own: "this automation's own memory",
        other: "the project memory",
      };
}

function editTool(handle: MemoryHandle): Tool {
  const { own, other } = notes(handle);
  return {
    name: "memory_edit",
    description: `Edit ${own}. It is one note; ${other} in the system prompt is a different note this tool never edits. Its entries are separate items: add appends one entry, replace and remove name one existing entry by a fragment of its text in old_text, which must match text inside one entry, never the whole note. none changes nothing and keeps pending chat reads when there is nothing to record. Changes are saved when the run ends.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove", "none"] },
        text: { type: "string" },
        old_text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(args) {
      const edit = parseEdit(args);
      const result = applyEdit(handle.work.entries, edit);
      if (!result.ok) {
        const advice =
          result.kind === "match"
            ? "old_text must match text inside one entry, never the whole note."
            : result.kind === "budget"
              ? "Merge or remove entries and retry."
              : "Retry with the arguments the action takes.";
        throw new Error(`${result.reason} ${advice}`);
      }
      handle.work.entries = result.entries;
      handle.work.operations.push(edit);
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
  if (action === "add") return { action, text: text(args, "text") };
  if (action === "replace") {
    return {
      action,
      oldText: text(args, "old_text"),
      text: text(args, "text"),
    };
  }
  if (action === "remove") {
    return { action, oldText: text(args, "old_text") };
  }
  throw new Error("action must be add, replace, remove or none");
}

// every refusal hands back the note as it stands, so the next call names
// an entry that is really there
function refusal(handle: MemoryHandle, reason: string): string {
  const entries = handle.work.entries;
  const size = `${memorySize(entries)} characters.`;
  if (entries.length === 0) {
    return `${reason}\nThe note is empty, use add.\n${size}`;
  }
  const lines = entries.map((entry, index) => {
    const first = entry.split("\n", 1)[0]!;
    const start = first.length > 64 ? `${first.slice(0, 61)}...` : first;
    return `${index + 1}. ${start} [${entry.length}/${MEMORY_ENTRY_CHARS}]`;
  });
  return `${reason}\n${size}\n${lines.join("\n")}`;
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
