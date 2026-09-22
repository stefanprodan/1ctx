// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A tool typed into bash gets one line naming how to call it; anything
// else bash could not find is left as it is.

import { expect, test } from "bun:test";
import { commandHints } from "../../../src/server/tools/bash-hint.ts";

const TOOLS = ["bash", "datetime", "mcp_call", "mcp_describe"];
const CATALOG = ["mcp__github__get_file_contents"];

test("a tool typed as a command is named once", () => {
  const printed =
    "bash: mcp_describe: command not found\nbash: mcp_describe: command not found\n\nexit 127";
  expect(commandHints(printed, TOOLS, CATALOG)).toBe(
    "bash: mcp_describe: command not found\nmcp_describe is one of your tools, not a command: call it as a tool, outside bash.\nbash: mcp_describe: command not found\n\nexit 127",
  );
});

test("a catalog MCP name points at mcp_call", () => {
  expect(
    commandHints(
      "bash: mcp__github__get_file_contents: command not found",
      TOOLS,
      CATALOG,
    ),
  ).toBe(
    "bash: mcp__github__get_file_contents: command not found\nmcp__github__get_file_contents is an MCP tool, not a command: call the mcp_call tool with name mcp__github__get_file_contents, outside bash.",
  );
});

test("other commands, mentions and bash itself are left alone", () => {
  for (const printed of [
    "bash: python: command not found",
    "bash: bash: command not found",
    "grep: mcp_call: No such file or directory",
    "echo bash: mcp_call: command not found later",
    "mcp_call",
  ]) {
    expect(commandHints(printed, TOOLS, CATALOG)).toBe(printed);
  }
});
