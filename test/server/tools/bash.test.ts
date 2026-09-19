// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell boundary uses the send's actor, not model-supplied identity.
// A command can fail after writing, so its error flag must survive the
// registry alongside the receipts.

import { describe, expect, test } from "bun:test";
import {
  acquire,
  acquireSession,
  heldSessions,
} from "../../../src/server/knowledge/queue.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { wireTokens } from "../../../src/server/providers/index.ts";
import { makeBashTool } from "../../../src/server/tools/builtin/bash.ts";
import { builtinCatalog } from "../../../src/server/tools/catalog.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import { Registry } from "../../../src/server/tools/registry.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";
import { settleRun } from "../../helpers/automations.ts";
import { chatApp, startChat, waitScript } from "../../helpers/chat.ts";
import { freshSignal, type Setup, setup } from "../knowledge/helpers.ts";

const context = (): ToolContext => ({
  actor: {
    projectId: "project",
    userId: "user",
    agentId: "agent",
    agentName: "coder",
    sessionId: "session",
    origin: "chat",
  },
  signal: new AbortController().signal,
  now: () => 0,
  budget: { bashCalls: 0, fetches: 0, searches: 0, visualBytes: 0, visuals: 0 },
  caps: TOOL_CAPS,
});

const call = (args: unknown) => ({
  id: "command",
  name: "bash",
  arguments: JSON.stringify(args),
});

function mountedContext(s: Setup): ToolContext {
  return {
    ...context(),
    actor: {
      projectId: s.projectId,
      userId: s.author.id,
      agentId: s.agent.id,
      agentName: s.agent.name,
      sessionId: s.session.id,
      origin: "chat",
    },
  };
}

describe("bash", () => {
  test("the catalog uses the command-only schema and its unfilled description", () => {
    const tool = makeBashTool();
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line, as for bash -c.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    });
    const listed = builtinCatalog(0, (text) => text).find(
      (entry) => entry.name === "bash",
    )!;
    expect(listed).toMatchObject({
      description: tool.description,
      parameters: tool.parameters,
      when: "knowledge",
      names: false,
      variant: null,
      tokens: 359,
    });
    expect(listed.tokens).toBe(wireTokens([tool]));
    expect(tool.description).not.toContain("{{year}}");
    expect(tool.description).toBe(
      "Run a bash command. The project's knowledge base, which people may call the project docs, is mounted at /knowledge: UTF-8 text files shared with everyone who can see the project. Use ls, find, grep -n, sed -n and sed -i, awk, jq, yq, diff, and cat > file <<'EOF' to write. Put independent commands in one round because calls run in parallel, and one command may read several files. Files you change there are saved when the command ends, each as a new version. If another writer changed one during the command nothing is saved and the result says so, so read it again and retry. Edit in place with sed -i. Read a file again in the same command before replacing it whole. Keep many small focused files, Markdown for prose, the file's purpose in its first line. /tmp is this session's scratch: any bytes, no versions, kept between commands until the session is deleted or unused for days. /uploads holds the files the user attached in this chat, text only, read-only: what you change there is not kept. Nothing else is kept. Each command starts a new shell in the directory the last one ended in. Variables and functions do not carry over. File names use letters, digits, dot, dash and underscore. No network. The result is the output and the exit status, cut when long. Never write secrets: anyone who can see this session or the project can read what you write.",
    );
  });

  test.each([false, true])(
    "forwards the actor, caps and signal and preserves error=%s",
    async (error) => {
      const ctx = context();
      const result = {
        content: `exit ${error ? 1 : 0}\nwrote docs/x.md (rev 2, 1 lines)`,
        error,
        tail: "exit 0\nwrote docs/x.md (rev 2, 1 lines)".length,
      };
      let calls = 0;
      const tool = makeBashTool({
        async run(projectId, sessionId, author, command, caps, signal) {
          calls++;
          expect(projectId).toBe("project");
          expect(sessionId).toBe("session");
          expect(author).toEqual({
            kind: "agent",
            id: "agent",
            name: "coder",
            sessionId: "session",
            origin: "chat",
          });
          expect(command).toBe("sed -i 's/hello/world/' docs/x.md");
          expect(caps).toEqual({
            callTimeoutMs: ctx.caps.callTimeoutMs,
            resultCut: ctx.caps.resultCut,
          });
          expect(signal.aborted).toBe(false);
          return result;
        },
      });
      expect(
        await new Registry([tool]).run(
          call({ command: "sed -i 's/hello/world/' docs/x.md" }),
          ctx,
        ),
      ).toEqual(result);
      expect(calls).toBe(1);
      expect(ctx.budget.bashCalls).toBe(1);
    },
  );

  test.serial(
    "a spent count never enters an occupied session queue or process slot",
    async () => {
      const s = setup();
      const ctx = mountedContext(s);
      ctx.caps = { ...ctx.caps, maxBashCalls: 1, callTimeoutMs: 100 };
      ctx.budget.bashCalls = 1;
      const registry = new Registry([makeBashTool(s.area)]);
      const slots = await Promise.all(
        Array.from({ length: 4 }, () => acquire(freshSignal())),
      );
      let releaseSession: (() => void) | undefined;
      try {
        const refused = registry.run(call({ command: "echo no > file" }), ctx);
        expect(heldSessions().has(s.session.id)).toBe(false);
        expect(await refused).toEqual({
          content: "the bash budget for this reply is spent",
          error: true,
        });
        releaseSession = await acquireSession(s.session.id, freshSignal());
        expect(
          await registry.run(call({ command: "echo no > file" }), ctx),
        ).toEqual({
          content: "the bash budget for this reply is spent",
          error: true,
        });
        releaseSession();
        expect(heldSessions().has(s.session.id)).toBe(false);
        expect(s.area.scratch.read(s.session.id).revision).toBe(0);
        expect(s.area.list(s.projectId).files).toEqual([]);
        expect(ctx.budget.bashCalls).toBe(1);
      } finally {
        releaseSession?.();
        for (const release of slots) release();
        s.db.close();
      }
    },
  );

  test.serial(
    "parallel calls claim the count in order before waiting",
    async () => {
      const s = setup();
      const ctx = mountedContext(s);
      ctx.caps = { ...ctx.caps, maxBashCalls: 2 };
      const registry = new Registry([makeBashTool(s.area)]);
      const release = await acquireSession(s.session.id, freshSignal());
      const pending = ["first", "second", "third", "fourth"].map((name) =>
        registry.run(call({ command: `echo ${name} > ${name}` }), ctx),
      );
      try {
        expect(ctx.budget.bashCalls).toBe(2);
        expect(await Promise.all(pending.slice(2))).toEqual([
          { content: "the bash budget for this reply is spent", error: true },
          { content: "the bash budget for this reply is spent", error: true },
        ]);
        expect(s.area.list(s.projectId).files).toEqual([]);
        release();
        const results = await Promise.all(pending.slice(0, 2));
        expect(results.map((result) => result.error)).toEqual([false, false]);
        expect(
          s.area
            .list(s.projectId)
            .files.map((file) => file.name)
            .sort(),
        ).toEqual(["first", "second"]);
        expect(s.area.scratch.read(s.session.id).revision).toBe(2);
      } finally {
        release();
        await Promise.all(pending);
        s.db.close();
      }
    },
  );

  test("the bash cap refuses the call while the tool loop continues", async () => {
    const chat = await chatApp();
    try {
      expect(
        (
          await chat.admin.call("PUT", "/api/limits", {
            body: { values: { ...DEFAULT_LIMITS, maxBashCalls: 1 } },
          })
        ).status,
      ).toBe(200);
      const { script, sessionId } = await startChat(chat);
      const bash = (id: string, command: string) => ({
        id,
        name: "bash",
        arguments: JSON.stringify({ command }),
      });
      script.toolRound([bash("first", "printf saved > kept")]);
      script.end();
      const second = await waitScript(chat.scripted, 2);
      second.toolRound([bash("spent", "printf refused > missing")]);
      second.end();
      const third = await waitScript(chat.scripted, 3);
      expect(third.body.messages).toContainEqual({
        role: "tool",
        tool_call_id: "spent",
        content: "the bash budget for this reply is spent",
      });
      third.toolRound([
        {
          id: "time",
          name: "datetime",
          arguments: JSON.stringify({ timezone: "UTC" }),
        },
      ]);
      third.end();
      const fourth = await waitScript(chat.scripted, 4);
      fourth.reply("The saved file is enough.");
      expect((await settleRun(chat, sessionId))?.status).toBe("done");
      const rows = chat.app.sessions.messages(sessionId);
      expect(rows.find((row) => row.toolCallId === "spent")?.status).toBe(
        "failed",
      );
      expect(rows.find((row) => row.toolCallId === "time")?.status).toBe(
        "done",
      );
      expect(rows.some((row) => row.finishReason === "tool_limit")).toBe(false);
      expect(
        chat.app.knowledge.list(chat.projectId).files.map((file) => file.name),
      ).toEqual(["kept"]);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("keeps the exit and every receipt as the tail through the registry", async () => {
    const s = setup();
    const ctx = mountedContext(s);
    ctx.caps = { ...ctx.caps, resultCut: 1000 };
    s.area.create(s.projectId, s.author, "old", "old");
    s.area.create(s.projectId, s.author, "source", "x".repeat(2000));
    try {
      const result = await new Registry([makeBashTool(s.area)]).run(
        call({
          command:
            "cat source; printf one > first; printf two > second; rm old; false",
        }),
        ctx,
      );
      const tail =
        "exit 1\nwrote first (rev 1, 1 lines)\nwrote second (rev 1, 1 lines)\ndeleted old";
      expect(result.error).toBe(true);
      expect(result.tail).toBe(tail.length);
      expect(result.content.slice(-result.tail!)).toBe(tail);
      expect(result.content).toContain("output cut at 1000 characters");
      expect(result.content.length).toBeLessThanOrEqual(1000);
    } finally {
      s.db.close();
    }
  });

  test("a missing actor fails without running a command", async () => {
    const ctx = context();
    ctx.actor = null;
    expect(
      await new Registry([makeBashTool()]).run(call({ command: "ls" }), ctx),
    ).toEqual({ error: true, content: "no project" });
  });

  test.each([
    {},
    { command: null },
    { command: 1 },
    { command: "ls", id: "x" },
  ])("refuses invalid arguments %j before calling knowledge", async (args) => {
    let calls = 0;
    const tool = makeBashTool({
      async run() {
        calls++;
        return { content: "exit 0", error: false };
      },
    });
    const result = await new Registry([tool]).run(call(args), context());
    expect(result.error).toBe(true);
    expect(result.content).toMatch(/command must be|accepts only command/);
    expect(calls).toBe(0);
  });

  test("a missing knowledge capability fails explicitly", async () => {
    expect(
      await new Registry([makeBashTool()]).run(
        call({ command: "ls" }),
        context(),
      ),
    ).toEqual({ error: true, content: "Error: knowledge is not configured" });
  });

  test("the call signal reaches knowledge through the registry", async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const tool = makeBashTool({
      async run(_projectId, _sessionId, _author, _command, _caps, signal) {
        controller.abort(new Error("stopped"));
        expect(signal.aborted).toBe(true);
        signal.throwIfAborted();
        return { content: "exit 0", error: false };
      },
    });
    expect(
      await new Registry([tool]).run(call({ command: "ls" }), ctx),
    ).toEqual({ error: true, content: "Error: stopped" });
  });
});
