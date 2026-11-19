// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Which results log `tool failed`, and what the line says of the cause.

import { expect, test } from "bun:test";
import { runOne } from "../../../src/server/runner/call.ts";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import type {
  Offered,
  ToolContext,
  ToolResult,
} from "../../../src/server/tools/types.ts";
import { collectLogs } from "../../helpers/app.ts";

const send = { sessionId: "s1" } as unknown as ActiveSend;
const offered = {} as unknown as Offered;
const call = { id: "c1", name: "bash", arguments: "{}" };
const ctx = {
  signal: new AbortController().signal,
} as unknown as ToolContext;

async function logged(run: () => Promise<ToolResult>) {
  const logs = collectLogs();
  const deps = {
    tools: { run, logName: () => "bash" },
    clock: () => 0,
    log: logs.logFactory("runner"),
  };
  const result = await runOne(deps, send, offered, call, ctx);
  const failed = logs.events.filter((event) => event.msg === "tool failed");
  return { result, fields: failed.map((event) => event.fields) };
}

test("a command's nonzero exit is its own answer and logs nothing", async () => {
  const { result, fields } = await logged(async () => ({
    content: "exit 1",
    error: true,
    exited: true,
  }));
  expect(result.error).toBe(true);
  expect(fields).toEqual([]);
});

test("a tool that throws logs its error's type", async () => {
  const { fields } = await logged(async () => {
    throw new TypeError("bad input");
  });
  expect(fields).toEqual([
    {
      chat: "s1",
      tool: "bash",
      duration: 0,
      error_type: "TypeError",
      error: "bad input",
    },
  ]);
});

test("an error result with nothing thrown logs a closed cause, no error type", async () => {
  const { fields } = await logged(async () => ({
    content: "the bash budget for this reply is spent",
    error: true,
  }));
  expect(fields).toEqual([
    { chat: "s1", tool: "bash", duration: 0, cause: "result" },
  ]);
});

test("a command that saved nothing logs where it ended and why", async () => {
  const { fields } = await logged(async () => ({
    content: "exit 124",
    error: true,
    ended: { phase: "run", cause: "limit" },
  }));
  expect(fields).toEqual([
    { chat: "s1", tool: "bash", duration: 0, phase: "run", cause: "limit" },
  ]);
});
