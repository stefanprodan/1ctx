// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell boundary uses the send's actor, not model-supplied identity.
// A command can fail after writing, so its error flag must survive the
// registry alongside the receipts.

import { describe, expect, test } from "bun:test";
import { makeBashTool } from "../../../src/server/tools/builtin/bash.ts";
import { builtinCatalog } from "../../../src/server/tools/catalog.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import { Registry } from "../../../src/server/tools/registry.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";

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
  budget: { fetches: 0, searches: 0, visualBytes: 0, visuals: 0 },
  caps: TOOL_CAPS,
});

const call = (args: unknown) => ({
  id: "command",
  name: "bash",
  arguments: JSON.stringify(args),
});

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
    });
    expect(tool.description).not.toContain("{{year}}");
    expect(tool.description).toContain(
      "No network and nothing outside /knowledge is kept.",
    );
    expect(tool.description).toContain(
      "Edit in place with sed -i; read a file again in the same command before replacing it whole.",
    );
  });

  test.each([false, true])(
    "forwards the actor, caps and signal and preserves error=%s",
    async (error) => {
      const ctx = context();
      const result = {
        content: `exit ${error ? 1 : 0}\nwrote docs/x.md (rev 2, 1 lines)`,
        error,
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
    },
  );

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
