// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import { EXHAUSTED_LINE } from "../../src/server/runner/context.ts";
import { type ChatApp, tick } from "./chat.ts";

// The fake clock lets a finalize retry resolve while the loop settles.
export async function settle(chat: ChatApp, times = 6) {
  for (let i = 0; i < times; i++) {
    await tick();
    chat.app.now.value += 200;
    await tick();
  }
}

export function shape(chat: ChatApp, sessionId: string) {
  return chat.app.sessions.messages(sessionId).map((row) => ({
    kind: row.kind,
    slot: row.slot,
    round: row.round,
    status: row.status,
    toolName: row.toolName,
    calls: row.toolCalls?.map((c) => c.name) ?? null,
  }));
}

export function answerNodes(chat: ChatApp, sessionId: string) {
  const rows = chat.app.sessions.messages(sessionId);
  const bySend = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySend.get(row.sendId) ?? [];
    list.push(row);
    bySend.set(row.sendId, list);
  }
  for (const [, list] of bySend) {
    const outside = list.filter(
      (row) =>
        row.kind === "user" ||
        (row.kind === "reply" &&
          (row.slot === "answer" ||
            (row.status === "streaming" && row.slot === null))),
    );
    expect(outside.filter((row) => row.kind === "user")).toHaveLength(1);
    expect(
      outside.filter((row) => row.kind === "reply").length,
    ).toBeLessThanOrEqual(1);
    expect(outside.map((row) => row.kind)).toEqual(
      outside.length === 1 ? ["user"] : ["user", "reply"],
    );
  }
}

export const time = (id: string, tz = "UTC") => ({
  id,
  name: "datetime",
  arguments: JSON.stringify({ timezone: tz }),
});

// the answer round asks in words, on the last message, and keeps the
// schemas as they were with no tool_choice, so the cached prefix holds
export function asksAnswer(body: Record<string, unknown>): boolean {
  const messages = body.messages as { content?: unknown }[];
  const last = messages.at(-1)?.content;
  return (
    typeof last === "string" &&
    last.includes(EXHAUSTED_LINE) &&
    body.tool_choice === undefined &&
    Array.isArray(body.tools) &&
    body.tools.length > 0
  );
}
