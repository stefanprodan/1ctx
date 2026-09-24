// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../../../src/server/providers/index.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { chatApp, type Script, waitScript } from "../../helpers/chat.ts";

function call(name: string, args: object | string): ToolCall {
  return {
    id: crypto.randomUUID(),
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
  };
}

function round(script: Script, calls: ToolCall[]): void {
  script.toolRound(calls);
  script.end();
}

describe("memory round settlement", () => {
  test("the phase stops after two failed rounds without another request", async () => {
    const chat = await chatApp();
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    const active = chat.app.runner.registry.get(run.sessionId)!;
    const handle = active.policy.memoryOffered!.memory!;
    run.main.reply("Done.");
    const first = await waitScript(chat.scripted, 2);
    round(first, [
      call("memory_edit", "{"),
      call("memory_edit", { action: "remove", topic: "missing" }),
      call("memory_edit", { action: "set" }),
    ]);
    const second = await waitScript(chat.scripted, 3);
    expect(handle.work.failedRounds).toBe(1);
    expect(handle.stopped).toBe(false);
    round(second, [call("memory_edit", "[]")]);
    await settleRun(chat, run.sessionId);

    expect(handle.work.failedRounds).toBe(2);
    expect(handle.stopped).toBe(true);
    expect(chat.scripted.scripts).toHaveLength(3);
    expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
      cause: "finish",
      status: "done",
      memoryRound: 2,
      memoryError: null,
      rounds: 3,
      toolCalls: 4,
    });
    const rows = chat.app.sessions.messages(run.sessionId);
    expect(
      rows.filter((row) => row.kind === "reply").map((row) => row.round),
    ).toEqual([1, 2, 3]);
    expect(rows.filter((row) => row.status === "streaming")).toEqual([]);
    expect(handle.work.entries).toEqual([]);
    expect(
      chat.app.memory.read({
        projectId: chat.projectId,
        automationId: automation.id,
      }).revision,
    ).toBe(0);
    await chat.app.shutdown();
  });
});
