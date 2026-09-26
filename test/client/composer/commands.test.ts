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
      "fork",
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
      command: COMMANDS[2],
      arg: "My Chat, As Typed",
    });
    expect(commandOf("/rename")).toEqual({ command: COMMANDS[2], arg: "" });
    expect(commandOf("/renamed x")).toBeNull();
    expect(commandFill(COMMANDS[0]!)).toBe("/compact");
    expect(commandFill(COMMANDS[2]!)).toBe("/rename ");
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
      onFork: async (title: string) => {
        calls.push(`fork:${title}`);
      },
    };
    const rename = commandOf("/rename My Chat")!;
    const compact = commandOf("/compact")!;
    const fork = commandOf("/fork second try")!;
    await runCommand(rename, null, handlers);
    await runCommand(compact, null, handlers);
    await runCommand(fork, null, handlers);
    expect(calls).toEqual(["rename:My Chat", "compact", "fork:second try"]);
    expect(runCommand(commandOf("/fork")!, null, handlers)).rejects.toThrow(
      "/fork needs a name",
    );
    expect(runCommand(rename, "a reply is running", handlers)).rejects.toThrow(
      "/rename: a reply is running",
    );
    expect(runCommand(compact, null, {})).rejects.toThrow("/compact: not now");
    expect(runCommand(commandOf("/rename")!, null, handlers)).rejects.toThrow(
      "/rename needs a title",
    );
    expect(calls.length).toBe(3);
  });

  test("a command is blocked before the chat starts and while it runs", () => {
    const compact = COMMANDS.find((c) => c.name === "compact")!;
    const rename = COMMANDS.find((c) => c.name === "rename")!;
    const fork = COMMANDS.find((c) => c.name === "fork")!;
    expect(commandBlock({ started: false, running: false }, compact)).toBe(
      "the chat has not started",
    );
    expect(commandBlock({ started: true, running: true }, compact)).toBe(
      "a reply is running",
    );
    expect(commandBlock({ started: true, running: false }, compact)).toBeNull();
    // a title is never the send's, so a rename runs under a reply
    expect(commandBlock({ started: true, running: true }, rename)).toBeNull();
    expect(commandBlock({ started: true, running: true }, fork)).toBe(
      "a reply is running",
    );
  });
});

describe("the command list", () => {
  test("is ordered by name", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });
});
