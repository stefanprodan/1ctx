// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A failed call's log line names a closed tool, never the name the model
// wrote, in the main loop and in an automation's memory phase.

import { describe, expect, test } from "bun:test";
import { collectLogs } from "../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import { chatApp, startChat, waitScript } from "../helpers/chat.ts";
import { settle } from "../helpers/tool-loop.ts";

const CANARY = "zz_canary_7f3e";

const failedEvents = (logs: ReturnType<typeof collectLogs>) =>
  logs.events.filter((event) => event.msg === "tool failed");

describe("a failed tool's log name", () => {
  test("the main loop logs an unknown name as unknown", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const started = await startChat(chat, "call it");
    started.script.toolRound([{ id: "c1", name: CANARY, arguments: "{}" }]);
    started.script.end();
    const answer = await waitScript(chat.scripted, 2);
    answer.reply("done");
    await settle(chat);
    expect(failedEvents(logs)).toEqual([
      {
        level: "warn",
        area: "runner",
        msg: "tool failed",
        fields: {
          chat: started.sessionId,
          tool: "unknown",
          duration: expect.any(Number),
          error_type: "ToolError",
          error: "tool not found",
        },
      },
    ]);
    expect(JSON.stringify(logs.events)).not.toContain(CANARY);
    await chat.app.shutdown();
  });

  test("the memory phase logs an unknown name as unknown", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    const automation = await createAutomation(chat, { ownMemory: true });
    const run = await startRun(chat, automation.id);
    run.main.reply("The check passed.");
    const phase = await waitScript(chat.scripted, 2);
    phase.toolRound([{ id: "m1", name: CANARY, arguments: "{}" }]);
    phase.end();
    const next = await waitScript(chat.scripted, 3);
    next.reply("No change.");
    await settleRun(chat, run.sessionId);
    const failed = failedEvents(logs);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.fields).toEqual({
      chat: run.sessionId,
      tool: "unknown",
      duration: expect.any(Number),
      error_type: "ToolError",
      error: "tool not found",
    });
    expect(JSON.stringify(logs.events)).not.toContain(CANARY);
    await chat.app.shutdown();
  });
});
