// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  cappedLines,
  MCP_PAGE_BYTES,
  pageLines,
} from "../../../src/server/mcp-server/result.ts";
import type { KnowledgeAuthor } from "../../../src/shared/contracts/knowledge.ts";
import { file, fixture, project, soleText, toolCall } from "./helper.ts";

describe("the inbound MCP result paging", () => {
  test("keeps long knowledge and session searches within 32 KiB", async () => {
    const { area, send, state } = fixture();
    const longAuthor: KnowledgeAuthor = {
      kind: "user",
      id: "user00000001",
      name: "a".repeat(32),
      sessionId: null,
      origin: "key",
      keyName: "k".repeat(80),
    };
    state.search = {
      names: Array.from({ length: 50 }, (_, index) => ({
        ...file(),
        id: `named${String(index).padStart(7, "0")}`,
        name: `${String(index).padStart(2, "0")}-${"n".repeat(220)}.md`,
        author: longAuthor,
      })),
      namesTotal: 50,
      files: Array.from({ length: 10 }, (_, index) => ({
        file: {
          ...file(),
          id: `found${String(index).padStart(7, "0")}`,
          name: `found-${String(index).padStart(2, "0")}.md`,
          author: longAuthor,
        },
        count: 3,
        lines: Array.from({ length: 3 }, (_, line) => ({
          line: line + 1,
          text: "match ".repeat(25),
          cutStart: false,
          cutEnd: false,
        })),
      })),
      next: "found-09.md",
    };
    let searchSkip = 0;
    let knowledgeRows = 0;
    for (let page = 0; page < 5; page++) {
      const knowledge = await toolCall(send, "knowledge", {
        action: "search",
        projectId: project.id,
        q: "match",
        ...(searchSkip === 0 ? {} : { skip: searchSkip }),
      });
      const text = soleText(knowledge);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024);
      knowledgeRows += text
        .split("\n")
        .filter((line) => line.startsWith('{"match"')).length;
      const next = text.match(/after=null, fileId=null, skip=(\d+)\./);
      if (next === null) break;
      searchSkip = Number(next[1]);
    }
    expect(knowledgeRows).toBe(60);

    state.sessionSearch = {
      hits: Array.from({ length: 10 }, (_, index) => ({
        id: `chat${String(index).padStart(8, "0")}`,
        title: `Result ${index} ${"t".repeat(180)}`,
        kind: "chat" as const,
        parentSessionId: null,
        lastActivityAt: 1_000 - index,
        count: 3,
        lines: Array.from({ length: 3 }, (_, line) => ({
          messageId: `msg${index}${line}`.padEnd(12, "0"),
          line: line + 1,
          text: "match ".repeat(25),
          cutStart: false,
          cutEnd: false,
        })),
      })),
      next: "900.chat00000009",
    };
    const sessions = await toolCall(send, "sessions", {
      action: "search",
      projectId: project.id,
      q: "match",
    });
    expect(Buffer.byteLength(soleText(sessions))).toBeLessThanOrEqual(
      32 * 1024,
    );
    await area.close();
  });

  test("refuses a row that cannot fit in a capped page", () => {
    expect(() =>
      cappedLines(["x".repeat(MCP_PAGE_BYTES + 1)], () => "next"),
    ).toThrow("a result row is longer than one page");
  });

  test("does not probe more than one page of minimum-size lines", () => {
    let largestEnd = 0;
    const page = pageLines("\n".repeat(4 * 1024 * 1024), 1, null, (part) => {
      largestEnd = Math.max(largestEnd, part.endLine);
      return part.text;
    });
    expect(page).not.toBeNull();
    expect(largestEnd).toBeLessThanOrEqual(MCP_PAGE_BYTES);
    expect(page!.page.endLine).toBe(MCP_PAGE_BYTES);
  });

  // a last row that fills the page exactly, found by sweeping sizes:
  // the page and its footer each end with a newline, so both count
  test("keeps a list whose last row fills the page within 32 KiB", async () => {
    const { send, state } = fixture();
    state.listed = Array.from({ length: 206 }, (_, index) => ({
      ...file("x"),
      id: `file${String(index).padStart(8, "0")}`,
      name: `n/${String(index).padStart(5, "0")}${index === 0 ? "p".repeat(228) : ""}.md`,
      ...(index === 205
        ? {
            bytes: 123456789012,
            lines: 987654321,
            revision: 99999999,
            author: {
              kind: "agent" as const,
              id: "agent0000001",
              name: "a".repeat(80),
              sessionId: "session00001",
              origin: "chat" as const,
              keyName: null,
            },
          }
        : {}),
    }));
    const files = await toolCall(send, "knowledge", {
      action: "list",
      projectId: project.id,
    });
    expect(Buffer.byteLength(files.result.content[0].text)).toBeLessThanOrEqual(
      MCP_PAGE_BYTES,
    );

    state.sessionList = {
      sessions: Array.from({ length: 117 }, (_, index) => ({
        id: `session${String(index).padStart(5, "0")}`,
        title: `${index === 0 ? "p".repeat(155) : ""}${"t".repeat(80)}`,
        kind: "chat" as const,
        parentSessionId: null,
        agent: "a".repeat(40),
        owner: "admin",
        lastActivityAt: 1,
        archived: false,
      })),
      next: null,
    };
    const sessions = await toolCall(send, "sessions", {
      action: "list",
      projectId: project.id,
    });
    expect(
      Buffer.byteLength(sessions.result.content[0].text),
    ).toBeLessThanOrEqual(MCP_PAGE_BYTES);
  });
});
