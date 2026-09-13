// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  commandBlock,
  commandMatches,
  commandOf,
  commandQuery,
  moveHighlight,
} from "../../../src/client/composer/commands.ts";

describe("slash commands", () => {
  test("a lone slash word is a query, a sentence is not", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/co")).toBe("co");
    expect(commandQuery("/compact now")).toBeNull();
    expect(commandQuery("compact")).toBeNull();
    expect(commandQuery("")).toBeNull();
  });

  test("the menu lists the commands the draft starts", () => {
    expect(commandMatches("/").map((c) => c.name)).toEqual(["compact"]);
    expect(commandMatches("/com").map((c) => c.name)).toEqual(["compact"]);
    expect(commandMatches("/x")).toEqual([]);
    expect(commandMatches("hello /compact")).toEqual([]);
  });

  test("only the exact word runs a command", () => {
    expect(commandOf("/compact")?.name).toBe("compact");
    expect(commandOf("  /compact \n")?.name).toBe("compact");
    expect(commandOf("/comp")).toBeNull();
    expect(commandOf("/compact please")).toBeNull();
  });

  test("the highlight wraps both ways", () => {
    expect(moveHighlight(0, 3, 1)).toBe(1);
    expect(moveHighlight(2, 3, 1)).toBe(0);
    expect(moveHighlight(0, 3, -1)).toBe(2);
    expect(moveHighlight(0, 0, 1)).toBe(0);
  });

  test("a command is blocked before the chat starts and while it runs", () => {
    expect(commandBlock({ started: false, running: false })).toBe(
      "the chat has not started",
    );
    expect(commandBlock({ started: true, running: true })).toBe(
      "a reply is running",
    );
    expect(commandBlock({ started: true, running: false })).toBeNull();
  });
});
