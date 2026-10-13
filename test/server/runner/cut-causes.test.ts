// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Which cause a cut row names: the send's own for the rows it cut, the
// later Stop or window of a step or phase only for the rows that step
// or phase opened.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { ATTENTION_STEP_MS } from "../../../src/server/runner/attention-step.ts";
import { cutText } from "../../../src/server/sessions/index.ts";
import type { Tools } from "../../../src/server/tools/index.ts";
import type {
  MemoryHandle,
  MemoryScope,
  Offered,
  ToolResult,
} from "../../../src/server/tools/types.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp, waitScript } from "../../helpers/chat.ts";

const tool = (name: string) => ({
  name,
  description: name,
  parameters: { type: "object" },
});

function base(names: string[]): Offered {
  return {
    tools: names.map(tool),
    visuals: false,
    knowledge: true,
    search: null,
    skills: { block: "", skills: [] },
    mcp: [],
    mcpPrompt: { text: "", digest: {} },
    mcpCatalog: "",
    memory: null,
    credentials: [],
    credentialsOff: [],
    web: null,
  };
}

// a phase handle with no note: the phase runs, nothing is committed
function memoryHandle(): MemoryHandle {
  return {
    work: null,
    chat: null,
    refused: new Map(),
    queue: Promise.resolve(),
    stopped: false,
    recordEdit() {},
    settleRound() {},
  };
}

// a fake tools port: datetime in the main rounds, attention in
// the attention step, memory_edit in the memory phase, each run by run
function phaseTools(run: Tools["run"]): Tools {
  return {
    capabilities: () => [],
    serverNames: () => [],
    skillsOff: () => [],
    offered: (
      _now: number,
      _agentId: string,
      _servers: unknown,
      _mode: unknown,
      scope?: MemoryScope,
    ) => {
      if (scope?.phase === "attention") {
        return {
          ...base(["attention"]),
          attention: {
            guidance: "when it fails",
            reason: null,
            answered: false,
          },
        };
      }
      if (scope?.phase === "memory") {
        return { ...base(["memory_edit"]), memory: memoryHandle() };
      }
      return base(["datetime"]);
    },
    run,
  } as unknown as Tools;
}

// ends only when the send aborts, by throwing as a tool does
const hang = (signal: AbortSignal) =>
  new Promise<ToolResult>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

const toolRows = (chat: ChatApp, sessionId: string) =>
  chat.app.sessions.messages(sessionId).filter((row) => row.kind === "tool");

async function stop(chat: ChatApp, sessionId: string) {
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/stop`,
  );
  expect(response.status).toBe(200);
}

describe("the cause a cut row names", () => {
  test("a Stop in the memory phase after the attention step ran out of time reads the stop", async () => {
    const reached = Promise.withResolvers<void>();
    const chat = await chatApp({
      tools: phaseTools(async (_offered, call, ctx) => {
        if (call.name === "memory_edit") reached.resolve();
        return hang(ctx.signal);
      }),
    });
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
        ownMemory: true,
      });
      const run = await startRun(chat, automation.id);
      run.main.reply("The check failed.");
      // the step's round never ends, so its window does
      await waitScript(chat.scripted, 2);
      chat.app.now.value += ATTENTION_STEP_MS;
      const phase = await waitScript(chat.scripted, 3);
      phase.toolRound([
        {
          id: "m1",
          name: "memory_edit",
          arguments: '{"action":"none"}',
        },
      ]);
      phase.end();
      await reached.promise;
      await stop(chat, run.sessionId);
      await settleRun(chat, run.sessionId);
      expect(toolRows(chat, run.sessionId)).toMatchObject([
        {
          toolName: "memory_edit",
          status: "stopped",
          content: cutText("stop", "write", false),
        },
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a Stop while a run waits on a tool its deadline cut keeps the deadline", async () => {
    const reached = Promise.withResolvers<void>();
    let release: (() => void) | null = null;
    const chat = await chatApp({
      tools: phaseTools(async () => {
        reached.resolve();
        // ignores the abort until the test lets it end, then throws
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error("the command was killed");
      }),
    });
    try {
      const automation = await createAutomation(chat);
      const run = await startRun(chat, automation.id);
      run.main.toolRound([
        { id: "t1", name: "datetime", arguments: '{"timezone":"UTC"}' },
      ]);
      run.main.end();
      await reached.promise;
      const send = chat.app.runner.registry.get(run.sessionId)!;
      const cut = new Promise((resolve) =>
        send.controller.signal.addEventListener("abort", resolve, {
          once: true,
        }),
      );
      chat.app.now.value += DEFAULT_LIMITS.runDeadlineMs;
      await cut;
      expect(send.cause).toBe("deadline");
      await stop(chat, run.sessionId);
      release!();
      await settleRun(chat, run.sessionId);
      expect(toolRows(chat, run.sessionId)).toMatchObject([
        {
          toolName: "datetime",
          status: "stopped",
          content: cutText("deadline", "read", false),
        },
      ]);
      expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
        cause: "deadline",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});
