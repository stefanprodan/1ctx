// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  changeNote,
  MAX_CHANGE_NAMES,
  MAX_CHANGE_NOTE,
} from "../../../src/server/mcp/note.ts";
import type { McpDigest } from "../../../src/shared/mcp.ts";

const server = (
  tools: Record<string, string>,
  instructions: string | null = null,
): McpDigest[string] => ({ tools, instructions });

describe("MCP change note", () => {
  test("names added, removed and changed tools and instructions", () => {
    const previous = {
      flux: server({ keep: "1", old: "1", changed: "1" }, "old"),
    };
    const current = {
      flux: server({ keep: "1", added: "1", changed: "2" }, "new"),
    };
    expect(changeNote(previous, current)).toBe(
      "Since your last turn in this chat, these MCP tools changed:\n" +
        "- flux: added added; removed old; changed changed; its instructions changed\n" +
        "Do not call a removed tool.",
    );
  });

  test("names a new server, a gone server and the last server removed", () => {
    expect(
      changeNote(
        { docs: server({ search: "1" }) },
        { flux: server({ get: "1" }) },
      ),
    ).toContain("- docs: no longer available\n- flux: now available");
    expect(changeNote({ flux: server({ get: "1" }) }, {})).toContain(
      "- flux: no longer available",
    );
  });

  test("notes instructions switched off without exposing their text", () => {
    const note = changeNote(
      { flux: server({}, "secret-old") },
      { flux: server({}, null) },
    );
    expect(note).toContain("its instructions changed");
    expect(note).not.toContain("secret-old");
  });

  test("shows twenty names and counts the rest", () => {
    const tools = Object.fromEntries(
      Array.from({ length: MAX_CHANGE_NAMES + 5 }, (_, index) => [
        `mcp__flux__tool_${String(index).padStart(2, "0")}`,
        "1",
      ]),
    );
    const note = changeNote({ flux: server({}) }, { flux: server(tools) });
    expect(note).toContain("and 5 more");
    expect(note).not.toContain("tool_24");
  });

  test("cuts a large note with the bounded suffix", () => {
    const previous: McpDigest = {};
    const current: McpDigest = {};
    for (let index = 0; index < 200; index++) {
      const name = `server-${String(index).padStart(3, "0")}`;
      current[name] = server({});
    }
    const note = changeNote(previous, current);
    expect(note.length).toBe(MAX_CHANGE_NOTE);
    expect(note.endsWith("and more changes")).toBe(true);
  });

  test("is empty for a first send and equal digests", () => {
    const digest = { flux: server({ get: "1" }, "instructions") };
    expect(changeNote(null, digest)).toBe("");
    expect(changeNote(digest, structuredClone(digest))).toBe("");
  });
});
