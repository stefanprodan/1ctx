// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The send-bound memory tools. Their shared queue preserves provider call
// order even though the runner launches one round's calls in parallel.

import {
  applyEdit,
  MEMORY_EDIT_FAILURES,
  MEMORY_SESSIONS_PER_RUN,
  type MemoryEdit,
} from "../../../shared/memory.ts";
import type { MemorySnapshot } from "../../sessions/index.ts";
import type { MemoryHandle, Tool, ToolContext } from "../types.ts";

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
      "List unread chats available to this project memory task, oldest first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run(args) {
      return throughQueue(handle, () => {
        noArgs(args);
        const read = handle.read!;
        const result = sessions.unread(
          read.automationId,
          read.projectId,
          MEMORY_SESSIONS_PER_RUN,
          [...read.marks.keys()],
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
        return lines.join("\n");
      });
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
      return throughQueue(handle, () =>
        readPage(handle, sessions, text(args, "id"), ctx),
      );
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
  if (read.marks.has(id)) throw new Error(`${id} was already read`);
  if (read.snapshot === null) {
    const snapshot = sessions.snapshot(read.projectId, id);
    if (snapshot === null) throw new Error("chat is unavailable");
    read.snapshot = { ...snapshot, cursor: 0 };
  }
  const snapshot = read.snapshot;
  const total = snapshot.markdown.length;
  const available = ctx.caps.resultCut;
  let end = Math.min(total, snapshot.cursor + available);
  if (end < total) {
    const digits = "9".repeat(String(total).length);
    const reserve = `\n${digits} characters left, call again`.length;
    end = Math.min(total, snapshot.cursor + Math.max(1, available - reserve));
  }
  const page = snapshot.markdown.slice(snapshot.cursor, end);
  snapshot.cursor = end;
  if (end === total) {
    read.marks.set(snapshot.id, snapshot.lastActivityAt);
    read.snapshot = null;
    return page;
  }
  return `${page}\n${total - end} characters left, call again`;
}

function editTool(handle: MemoryHandle): Tool {
  const note =
    handle.note === "project"
      ? "the project's memory"
      : "this automation's memory";
  return {
    name: "memory_edit",
    description: `Edit ${note}. Changes are saved when the run ends.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove"] },
        text: { type: "string" },
        old_text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(args) {
      return throughQueue(handle, () => {
        if (handle.work.failures >= MEMORY_EDIT_FAILURES) {
          throw new Error(failure(handle, "Stop editing and finish."));
        }
        const edit = parseEdit(args);
        const result = applyEdit(handle.work.entries, edit);
        if (!result.ok) {
          handle.work.failures++;
          const suffix =
            handle.work.failures >= MEMORY_EDIT_FAILURES
              ? " Stop editing and finish."
              : " Merge or remove entries and retry.";
          throw new Error(failure(handle, `${result.reason}${suffix}`));
        }
        handle.work.entries = result.entries;
        handle.work.operations.push(edit);
        return `Saved for the end of the run in ${note}.`;
      });
    },
  };
}

function parseEdit(args: Record<string, unknown>): MemoryEdit {
  const action = args.action;
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
  throw new Error("action must be add, replace or remove");
}

function failure(handle: MemoryHandle, reason: string): string {
  const lines = handle.work.entries.map(
    (entry, index) => `${index + 1}. ${entry}`,
  );
  return `${reason}\n${handle.work.entries.length} entries\n${lines.join("\n")}`;
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
