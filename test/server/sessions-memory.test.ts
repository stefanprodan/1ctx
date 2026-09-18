// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  chatMarkdown,
  type ExportRow,
  memorySnapshot,
  type SessionRow,
} from "../../src/server/sessions/index.ts";
import {
  makeMemoryHandle,
  makeMemoryTools,
} from "../../src/server/tools/builtin/memory.ts";
import { TOOL_CAPS, type ToolContext } from "../../src/server/tools/index.ts";
import { classify, splitWireName } from "../../src/shared/mcp.ts";
import incident from "../fixtures/memory/incident.json";

const now = Date.UTC(2026, 8, 16, 10);
const row = (fields: Partial<ExportRow>): ExportRow => ({
  sendId: "send",
  round: 1,
  memoryRound: null,
  kind: "reply",
  slot: null,
  status: "done",
  error: null,
  finishReason: null,
  author: null,
  content: "",
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  createdAt: now,
  finishedAt: now,
  ...fields,
});
const rows = (incident.rows as Partial<ExportRow>[]).map(row);
const session: SessionRow = {
  id: "chat",
  projectId: "project",
  ownerId: "user",
  agentId: "agent",
  origin: "chat",
  forkedFromId: null,
  automationId: null,
  runSource: null,
  title: incident.title,
  status: "done",
  revision: 1,
  createdAt: now,
  lastActivityAt: now + 120_000,
  usage: null,
};
const sides = classify(
  "flux",
  incident.toolNames.map((name) => ({ name, unusable: null })),
  { read: incident.readPatterns, write: [], excluded: [] },
);
const isWrite = (name: string): boolean => {
  const split = splitWireName(name);
  return split?.server === "flux" && sides.get(split.tool) === "write";
};
const snapshot = (messages = rows, current = session) =>
  memorySnapshot(
    "project",
    "chat",
    { byId: () => current, exportRows: () => messages },
    isWrite,
  )!;

describe("memory chat receipts", () => {
  test("lists parallel calls in call order before the answer, without results or work", () => {
    const before = structuredClone(rows);
    const result = snapshot();
    expect(result.lastActivityAt).toBe(session.lastActivityAt);
    expect(result.markdown).toBe(
      `# ${incident.title}\n\n## @caelea 2026-09-16 10:00\n\n${rows[0]!.content}\n\n## @coder 2026-09-16 10:02\n\nTools:\n${incident.receipts.join("\n")}\n\n${rows.at(-1)!.content}\n`,
    );
    for (const text of incident.absent) {
      expect(result.markdown).not.toContain(text);
    }
    expect(rows).toEqual(before);
  });

  test("Download stays the answer only", () => {
    expect(chatMarkdown(incident.title, rows, "UTC")).toBe(
      `# ${incident.title}\n\n## @caelea 2026-09-16 10:00\n\n${rows[0]!.content}\n\n## @coder 2026-09-16 10:02\n\n${rows.at(-1)!.content}\n`,
    );
  });

  test("does not mark deleted servers, unknown tools or built-ins as writes", () => {
    const names = [
      "mcp__deleted__delete_kubernetes_resource",
      "mcp__flux__unknown",
      "bash",
      "datetime",
      "webfetch",
      "websearch",
      "skill",
      "skill_file",
      "sessions_list",
      "session_read",
      "memory_edit",
    ];
    const text = snapshot([
      row({
        slot: "work",
        toolCalls: names.map((name) => ({ id: name, name, arguments: "{}" })),
      }),
      ...names.map((name) =>
        row({ kind: "tool", toolCallId: name, toolName: name }),
      ),
    ]).markdown;
    expect(text).toContain("Tools:");
    expect(text).not.toContain("(write)");
    for (const name of names) expect(text).toContain(`- ${name} {} : done`);
  });

  test("a bash receipt names the command without trusting its output", () => {
    const command = JSON.stringify({
      command: "sed -i 's/hello/world/' docs/x.md",
    });
    const messages = [
      row({
        slot: "work",
        toolCalls: [{ id: "bash", name: "bash", arguments: command }],
      }),
      row({
        kind: "tool",
        toolCallId: "bash",
        toolName: "bash",
        content: "exit 0\nwrote docs/x.md (rev 2, 1 lines)",
      }),
    ];
    const text = snapshot(messages).markdown;
    expect(text).toContain(`- bash ${command} : done`);
    expect(text).not.toContain("(write)");
    expect(text).not.toContain("wrote docs/x.md");
    expect(text).not.toContain("exit 0");
    expect(chatMarkdown("Chat", messages, "UTC")).not.toContain(command);
  });

  test.each([199, 200, 201, 250])(
    "collapses whitespace and caps %i argument characters including the ellipsis",
    (size) => {
      const argumentsText = ` \n\t${"a".repeat(size)} \r\n `;
      const text = snapshot([
        row({
          slot: "work",
          toolCalls: [
            { id: "call", name: "datetime", arguments: argumentsText },
          ],
        }),
      ]).markdown;
      const argument = text.split("- datetime ")[1]!.split(" : not run")[0]!;
      expect(argument).toBe(
        size <= 200 ? "a".repeat(size) : `${"a".repeat(197)}...`,
      );
      expect(argument.length).toBe(Math.min(200, size));
    },
  );

  test("does not split a surrogate pair at the argument cut", () => {
    const text = snapshot([
      row({
        slot: "work",
        toolCalls: [
          { id: "c", name: "datetime", arguments: `${"a".repeat(196)}😀more` },
        ],
      }),
    ]).markdown;
    expect(text).toContain(`- datetime ${"a".repeat(196)}... : not run`);
    expect(text.isWellFormed()).toBe(true);
  });

  test("matches reused call ids within each round and send, and consumes each tool row once", () => {
    const call = { id: "same", name: "datetime", arguments: "{}" };
    const text = snapshot([
      row({ slot: "work", toolCalls: [call, call, call] }),
      row({ kind: "tool", toolCallId: "same" }),
      row({ kind: "tool", toolCallId: "same", status: "failed" }),
      row({ round: 2, slot: "work", toolCalls: [call] }),
      row({ round: 2, kind: "tool", toolCallId: "same", status: "stopped" }),
      row({ sendId: "next", slot: "work", toolCalls: [call] }),
    ]).markdown;
    expect(text.match(/- datetime \{\} : [^\n]+/g)).toEqual([
      "- datetime {} : done",
      "- datetime {} : failed",
      "- datetime {} : not run",
      "- datetime {} : failed",
      "- datetime {} : not run",
    ]);
  });

  test("a failed tool without an answer never exposes its error through the cut line", () => {
    const messages = rows.slice(0, 3);
    expect(chatMarkdown("chat", messages, "UTC")).toContain(
      "TOOL\\_ERROR\\_MUST\\_NOT\\_APPEAR",
    );
    const text = snapshot(messages).markdown;
    expect(text).toContain(": failed");
    expect(text).toContain("_failed_");
    expect(text).not.toContain("TOOL");
  });

  test("running turns and summaries have no receipts, and runs remain unreadable", () => {
    const text = snapshot([
      ...rows,
      row({
        sendId: "running",
        slot: "work",
        status: "streaming",
        toolCalls: [{ id: "live", name: "live_tool", arguments: "{}" }],
      }),
      row({
        sendId: "compact",
        kind: "summary",
        content: "SUMMARY_MUST_NOT_APPEAR",
      }),
    ]).markdown;
    expect(text).not.toContain("live_tool");
    expect(text).not.toContain("SUMMARY_MUST_NOT_APPEAR");
    expect(snapshot(rows, { ...session, origin: "automation" })).toBeNull();
    expect(snapshot(rows, { ...session, status: "running" })).toBeNull();
    expect(snapshot(rows, { ...session, projectId: "other" })).toBeNull();
  });

  test("pages receipts from one snapshot and marks its original activity only after the last page", async () => {
    const original = snapshot();
    let current = original;
    let reads = 0;
    const handle = makeMemoryHandle(
      {
        target: { projectId: "project", automationId: null },
        baseRevision: 0,
        entries: [],
        operations: [],
        failedRounds: 0,
      },
      "automation",
    );
    const tools = makeMemoryTools(handle, {
      snapshot: () => {
        reads++;
        return current;
      },
      unread: () => ({ chats: [], remaining: 0 }),
    });
    const read = tools.find((tool) => tool.name === "session_read")!;
    const ctx: ToolContext = {
      actor: null,
      signal: new AbortController().signal,
      now: () => now,
      budget: {
        bashCalls: 0,
        fetches: 0,
        searches: 0,
        visualBytes: 0,
        visuals: 0,
      },
      caps: { ...TOOL_CAPS, resultCut: 400 },
    };
    const pages: string[] = [];
    do {
      expect(handle.read!.pending.size).toBe(0);
      const page = await read.run({ id: "chat" }, ctx);
      expect(page.length).toBeLessThanOrEqual(ctx.caps.resultCut);
      pages.push(page.slice(0, page.lastIndexOf("\n")));
      current = {
        ...original,
        lastActivityAt: now + 1_000_000,
        markdown: "new",
      };
      if (handle.read!.snapshot !== null) {
        expect(page).toEndWith(
          `${original.markdown.length - pages.join("").length} characters left, call again`,
        );
        await expect(read.run({ id: "other" }, ctx)).rejects.toThrow(
          "finish reading chat first",
        );
      }
    } while (handle.read!.snapshot !== null);
    expect(reads).toBe(1);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(original.markdown);
    expect(handle.read!.pending.get("chat")).toBe(original.lastActivityAt);
    expect(handle.read!.marks.size).toBe(0);
    const edit = tools.find((tool) => tool.name === "memory_edit")!;
    await edit.run({ action: "none" }, ctx);
    expect(handle.read!.pending.size).toBe(0);
    expect(handle.read!.marks.get("chat")).toEqual({
      readActivityAt: original.lastActivityAt,
      operation: 0,
    });
  });
});
