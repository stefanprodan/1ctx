// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send cut while its calls run: a call that reported its end keeps
// it whole, any other gets the cut text, which the next send reads.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { FINALIZE_RETRY_MS } from "../../../src/server/runner/index.ts";
import { cutText } from "../../../src/server/sessions/index.ts";
import type { Tools } from "../../../src/server/tools/index.ts";
import { Registry } from "../../../src/server/tools/registry.ts";
import type { Tool, ToolResult } from "../../../src/server/tools/types.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

const call = (id: string, name: string) => ({
  id,
  name,
  arguments: "{}",
});

// a round that small a window holds until every call settles
const BUFFERED = { prompt: 10_000, completion: 100 };

// a fake tools port offering the given names and running them with run
function fakeTools(
  names: string[],
  run: Tools["run"],
): Pick<
  Tools,
  "capabilities" | "serverNames" | "skillsOff" | "offered" | "run"
> {
  return {
    capabilities: () => [],
    serverNames: () => [],
    skillsOff: () => [],
    offered: () => ({
      tools: names.map((name) => ({
        name,
        description: name,
        parameters: { type: "object" },
      })),
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
    }),
    run,
  };
}

// a call that ends only when the send aborts, by throwing as a tool does
const hang = (signal: AbortSignal) =>
  new Promise<ToolResult>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

// a completed bash end with every field a row keeps
function completion(resultCut: number): ToolResult {
  const tail = "\nexit 0";
  return {
    content: `${"x".repeat(resultCut + 100)}${tail}`,
    error: false,
    tail: tail.length,
    saved: ["/knowledge/notes.md"],
    opened: [
      {
        path: "/knowledge/notes.md",
        kind: "markdown",
        language: null,
        bytes: 5,
        lines: 1,
        title: null,
        text: "notes",
      },
    ],
    kept: [
      {
        folder: 1,
        dir: "1",
        name: "result.json",
        text: "{}",
        data: null,
        bytes: 2,
      },
    ],
  };
}

const toolRows = (chat: ChatApp, sessionId: string) =>
  chat.app.sessions.messages(sessionId).filter((row) => row.kind === "tool");

const count = (chat: ChatApp, table: string, messageId: string) =>
  chat.app.db
    .query<{ n: number }, [string]>(
      `select count(*) as n from ${table} where message_id = ?`,
    )
    .get(messageId)!.n;

async function waitRows(
  chat: ChatApp,
  sessionId: string,
  check: (statuses: string[]) => boolean,
) {
  for (let i = 0; i < 400; i++) {
    if (check(toolRows(chat, sessionId).map((row) => row.status))) return;
    await tick();
  }
  throw new Error("the tool rows never reached the state");
}

async function stop(chat: ChatApp, sessionId: string) {
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/stop`,
  );
  expect(response.status).toBe(200);
}

describe("a cut send's tool rows", () => {
  test("a completion in a buffered round keeps its whole end, the hanging sibling the stop text, and the next send reads both", async () => {
    let finished = false;
    const chat = await chatApp({
      window: 20_000,
      tools: fakeTools(
        ["bash", "visualize"],
        async (_offered, toolCall, ctx) => {
          if (toolCall.name === "bash") {
            finished = true;
            return completion(ctx.caps.resultCut);
          }
          return hang(ctx.signal);
        },
      ),
    });
    try {
      const { script, sessionId } = await startChat(chat);
      const resultCut =
        chat.app.runner.registry.get(sessionId)!.policy.toolCaps.resultCut;
      script.toolRound(
        [call("done", "bash"), call("open", "visualize")],
        BUFFERED,
      );
      script.end();
      for (let i = 0; i < 200 && !finished; i++) await tick();
      await tick();
      // held for the fit, so nothing is written yet
      expect(toolRows(chat, sessionId).map((row) => row.status)).toEqual([
        "streaming",
        "streaming",
      ]);
      await stop(chat, sessionId);
      await settleRun(chat, sessionId);

      const [done, open] = toolRows(chat, sessionId);
      expect(done).toMatchObject({ status: "done", error: null });
      expect(done!.content).toHaveLength(resultCut);
      expect(done!.content).toEndWith("\nexit 0");
      expect(done!.saved).toMatchObject({ paths: ["/knowledge/notes.md"] });
      expect(count(chat, "opened_files", done!.id)).toBe(1);
      expect(count(chat, "mcp_kept_files", done!.id)).toBe(1);
      expect(open).toMatchObject({
        status: "stopped",
        error: null,
        content: cutText("stop", "write", false),
      });

      const pending = chat.scripted.next();
      const sent = await chat.member.call(
        "POST",
        `/api/sessions/${sessionId}/messages`,
        { body: { message: "again" } },
      );
      expect(sent.status).toBe(201);
      const next = await pending;
      const tools = (
        next.body.messages as { role: string; content: string }[]
      ).filter((message) => message.role === "tool");
      expect(tools.map((message) => message.content)).toEqual([
        done!.content,
        cutText("stop", "write", false),
      ]);
      next.reply("ok");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a throw after the abort is interrupted and logs nothing, a failure of its own keeps its error", async () => {
    const logs = collectLogs();
    const tools: Tool<string>[] = [
      {
        name: "webfetch",
        description: "fails on its own",
        parameters: { type: "object" },
        run: async () => {
          throw new Error("the page is gone");
        },
      },
      {
        name: "websearch",
        description: "ends only on the abort",
        parameters: { type: "object" },
        run: async (_args, ctx) => {
          await hang(ctx.signal);
          return "never";
        },
      },
    ];
    let failed = false;
    const chat = await chatApp({
      window: 20_000,
      logFactory: logs.logFactory,
      tools: fakeTools(["webfetch", "websearch"], async (_o, toolCall, ctx) => {
        const result = await new Registry(tools).run(toolCall, ctx);
        if (toolCall.name === "webfetch") failed = true;
        return result;
      }),
    });
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound(
        [call("own", "webfetch"), call("cut", "websearch")],
        BUFFERED,
      );
      script.end();
      for (let i = 0; i < 200 && !failed; i++) await tick();
      await stop(chat, sessionId);
      await settleRun(chat, sessionId);

      expect(
        toolRows(chat, sessionId).map((row) => ({
          status: row.status,
          content: row.content,
        })),
      ).toEqual([
        { status: "failed", content: "Error: the page is gone" },
        { status: "stopped", content: cutText("stop", "read", false) },
      ]);
      // the own failure alone; the fake port names no tool
      expect(
        logs.events.filter((event) => event.msg === "tool failed"),
      ).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "a call that settles in the tick of the stop is written once",
    async () => {
      const seen: BusEvent[] = [];
      const unsubscribe = subscribe((event) => seen.push(event), silent);
      const chat = await chatApp({
        tools: fakeTools(["bash"], async (_offered, _call, ctx) => {
          return new Promise((resolve) => {
            ctx.signal.addEventListener(
              "abort",
              () => resolve(completion(ctx.caps.resultCut)),
              { once: true },
            );
          });
        }),
      });
      try {
        const { script, sessionId } = await startChat(chat);
        script.toolRound([call("late", "bash")]);
        script.end();
        await waitRows(chat, sessionId, (s) => s[0] === "streaming");
        await stop(chat, sessionId);
        await settleRun(chat, sessionId);
        const [row] = toolRows(chat, sessionId);
        expect(row).toMatchObject({ status: "done" });
        expect(count(chat, "mcp_kept_files", row!.id)).toBe(1);
        const ends = seen.filter(
          (event) =>
            event.type === "session.changed" &&
            event.data.messages.some(
              (message) => message.id === row!.id && message.status === "done",
            ),
        );
        expect(ends).toHaveLength(1);
      } finally {
        unsubscribe();
        await chat.app.shutdown();
      }
    },
  );

  test("a finalization that fails once writes the completions on its retry, once", async () => {
    let finished = false;
    const chat = await chatApp({
      window: 20_000,
      tools: fakeTools(
        ["bash", "visualize"],
        async (_offered, toolCall, ctx) => {
          if (toolCall.name === "bash") {
            finished = true;
            return completion(ctx.caps.resultCut);
          }
          return hang(ctx.signal);
        },
      ),
    });
    try {
      const { script, sessionId, detail } = await startChat(chat);
      script.toolRound(
        [call("done", "bash"), call("open", "visualize")],
        BUFFERED,
      );
      script.end();
      for (let i = 0; i < 200 && !finished; i++) await tick();
      const store = chat.app.sessions;
      const original = store.finishSend.bind(store);
      let attempts = 0;
      store.finishSend = (id, fields) => {
        attempts++;
        if (attempts === 1) throw new Error("first finalize failed");
        return original(id, fields);
      };
      await stop(chat, sessionId);
      for (let i = 0; i < 50 && attempts === 0; i++) await tick();
      // the first attempt rolled the completion back with the rest
      expect(toolRows(chat, sessionId)[0]!.status).toBe("streaming");
      chat.app.now.value += FINALIZE_RETRY_MS;
      await settleRun(chat, sessionId);
      store.finishSend = original;

      expect(attempts).toBe(2);
      const [done, open] = toolRows(chat, sessionId);
      expect(done).toMatchObject({ status: "done" });
      expect(count(chat, "opened_files", done!.id)).toBe(1);
      expect(count(chat, "mcp_kept_files", done!.id)).toBe(1);
      expect(open).toMatchObject({
        status: "stopped",
        content: cutText("stop", "write", false),
      });
      expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
        status: "stopped",
        cause: "stop",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a completion the cut cannot write", () => {
  test("logs the failed write and leaves the row the cut text", async () => {
    const logs = collectLogs();
    let finished = false;
    const chat = await chatApp({
      window: 20_000,
      logFactory: logs.logFactory,
      tools: fakeTools(
        ["bash", "visualize"],
        async (_offered, toolCall, ctx) => {
          if (toolCall.name === "bash") {
            finished = true;
            return completion(ctx.caps.resultCut);
          }
          return hang(ctx.signal);
        },
      ),
    });
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound(
        [call("done", "bash"), call("open", "visualize")],
        BUFFERED,
      );
      script.end();
      for (let i = 0; i < 200 && !finished; i++) await tick();
      const store = chat.app.sessions;
      const original = store.finishTool.bind(store);
      store.finishTool = (id, fields) => {
        if (fields.status === "done") throw new Error("disk full");
        return original(id, fields);
      };
      await stop(chat, sessionId);
      await settleRun(chat, sessionId);
      store.finishTool = original;

      const [done, open] = toolRows(chat, sessionId);
      expect(done).toMatchObject({
        status: "stopped",
        content: cutText("stop", "bash", false),
      });
      expect(count(chat, "mcp_kept_files", done!.id)).toBe(0);
      expect(open).toMatchObject({
        status: "stopped",
        content: cutText("stop", "write", false),
      });
      expect(
        logs.events.filter((event) => event.msg === "tool end not written"),
      ).toMatchObject([
        { level: "warn", fields: { chat: sessionId, error: "disk full" } },
      ]);
      expect(chat.app.sessions.byId(sessionId)?.status).toBe("stopped");
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a run cut by its deadline before its memory phase", () => {
  test("keeps the completed rows and gives an aborted command the deadline text", async () => {
    const chat = await chatApp({ window: 20_000 });
    try {
      const automation = await createAutomation(chat, { ownMemory: true });
      const run = await startRun(chat, automation.id);
      run.main.toolRound(
        [
          {
            id: "time",
            name: "datetime",
            arguments: '{"timezone":"UTC"}',
          },
          {
            id: "slow",
            name: "bash",
            arguments: JSON.stringify({
              command: "echo x > /tmp/late; sleep 60",
            }),
          },
        ],
        BUFFERED,
      );
      run.main.end();
      await waitRows(chat, run.sessionId, (s) => s.length === 2);
      // the command is running before the deadline rings
      for (let i = 0; i < 100; i++) await tick();
      chat.app.now.value += DEFAULT_LIMITS.runDeadlineMs;
      const phase = await waitScript(chat.scripted, 2);
      const [time, slow] = toolRows(chat, run.sessionId);
      expect(time).toMatchObject({ status: "done", toolName: "datetime" });
      expect(time!.content).not.toContain("Error");
      expect(slow).toMatchObject({
        status: "stopped",
        toolName: "bash",
        content: cutText("deadline", "bash", true),
      });
      phase.reply("Recorded the cutoff.");
      await settleRun(chat, run.sessionId);
      expect(chat.app.sessions.lastSend(run.sessionId)).toMatchObject({
        cause: "deadline",
        status: "stopped",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});
