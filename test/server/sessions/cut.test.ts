// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { cutKind, cutText } from "../../../src/server/sessions/index.ts";

describe("the cut text", () => {
  test("says why, that nothing was recorded, then what may have happened", () => {
    expect(cutText("stop", "read", false)).toBe(
      "The user stopped the send. No result was recorded. It only reads; calling it again is safe.",
    );
    expect(cutText("restart", "write", false)).toBe(
      "The server restarted unexpectedly. No result was recorded. It may have taken effect; check before calling it again.",
    );
  });

  test.each([
    ["stop", "The user stopped the send."],
    ["deadline", "The send reached its deadline."],
    ["failure", "The send failed."],
    ["shutdown", "The server shut down."],
    ["restart", "The server restarted unexpectedly."],
  ] as const)("names the %s cause", (cause, why) => {
    expect(cutText(cause, "write", false)).toStartWith(`${why} `);
  });

  test("says discarded only for a bash that reported it", () => {
    expect(cutText("stop", "bash", true)).toContain(
      "Its file changes were discarded.",
    );
    expect(cutText("stop", "bash", false)).toContain(
      "File changes may have been saved",
    );
    expect(cutText("stop", "delegate", true)).not.toContain("discarded");
  });

  test("reads the kind from the name, an MCP tool from its side", () => {
    for (const name of [
      "webfetch",
      "websearch",
      "datetime",
      "skill",
      "skill_file",
      "mcp_describe",
    ]) {
      expect(cutKind(name, null)).toBe("read");
    }
    expect(cutKind("bash", null)).toBe("bash");
    expect(cutKind("delegate", null)).toBe("delegate");
    expect(cutKind("mcp__flux__get", "read")).toBe("mcp-read");
    expect(cutKind("mcp__flux__apply", "write")).toBe("write");
    expect(cutKind("mcp__flux__get", null)).toBe("write");
    for (const name of [
      "memory_edit",
      "email_user",
      "needs_attention",
      "visualize",
      "made_up",
    ]) {
      expect(cutKind(name, null)).toBe("write");
    }
  });
});
