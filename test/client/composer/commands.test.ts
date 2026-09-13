// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  commandBlock,
  commandFill,
  commandMatches,
  commandOf,
  commandQuery,
  moveHighlight,
  runCommand,
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
    expect(commandMatches("/").map((c) => c.name)).toEqual([
      "compact",
      "rename",
    ]);
    expect(commandMatches("/com").map((c) => c.name)).toEqual(["compact"]);
    expect(commandMatches("/x")).toEqual([]);
    expect(commandMatches("hello /compact")).toEqual([]);
    expect(commandMatches("/rename My chat")).toEqual([]);
  });

  test("only the exact word runs a command", () => {
    expect(commandOf("/compact")?.command.name).toBe("compact");
    expect(commandOf("  /compact \n")?.command.name).toBe("compact");
    expect(commandOf("/comp")).toBeNull();
    expect(commandOf("/compact please")).toBeNull();
  });

  test("a command with an argument keeps the rest as typed", () => {
    expect(commandOf("/rename  My Chat, As Typed ")).toEqual({
      command: COMMANDS[1],
      arg: "My Chat, As Typed",
    });
    expect(commandOf("/rename")).toEqual({ command: COMMANDS[1], arg: "" });
    expect(commandOf("/renamed x")).toBeNull();
    expect(commandFill(COMMANDS[0]!)).toBe("/compact");
    expect(commandFill(COMMANDS[1]!)).toBe("/rename ");
  });

  test("the highlight wraps both ways", () => {
    expect(moveHighlight(0, 3, 1)).toBe(1);
    expect(moveHighlight(2, 3, 1)).toBe(0);
    expect(moveHighlight(0, 3, -1)).toBe(2);
    expect(moveHighlight(0, 0, 1)).toBe(0);
  });

  test("Enter runs the handler, or refuses with the reason", async () => {
    const calls: string[] = [];
    const handlers = {
      onCompact: async () => {
        calls.push("compact");
      },
      onRename: async (title: string) => {
        calls.push(`rename:${title}`);
      },
    };
    const rename = commandOf("/rename My Chat")!;
    const compact = commandOf("/compact")!;
    await runCommand(rename, null, handlers);
    await runCommand(compact, null, handlers);
    expect(calls).toEqual(["rename:My Chat", "compact"]);
    expect(runCommand(rename, "a reply is running", handlers)).rejects.toThrow(
      "/rename: a reply is running",
    );
    expect(runCommand(compact, null, {})).rejects.toThrow("/compact: not now");
    expect(runCommand(commandOf("/rename")!, null, handlers)).rejects.toThrow(
      "/rename needs a title",
    );
    expect(calls.length).toBe(2);
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
