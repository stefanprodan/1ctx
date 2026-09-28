// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../src/server/limits/index.ts";
import { wireTokens } from "../../src/server/providers/index.ts";
import type { ToolsResponse } from "../../src/shared/api/tools.ts";
import { chatApp, NO_TOOLS, startChat, tick } from "../helpers/chat.ts";

describe("visual tool administration", () => {
  test("saved hosts change the next schema and its catalog token count", async () => {
    const chat = await chatApp();
    try {
      const first = await startChat(chat, "first");
      const before = chat.app.runner.registry.get(first.sessionId)!;
      const initial = before.policy.offered.tools.find(
        (tool) => tool.name === "visualize",
      )!;
      expect(initial).toBeDefined();
      const res = await chat.admin.call("PATCH", "/api/tools/visualize", {
        body: {
          hosts: ["https://Z.test/", "https://a.test", "https://a.test/"],
        },
      });
      expect(res.status).toBe(200);
      const body: ToolsResponse = await res.json();
      const catalog = body.visualize;
      expect(catalog.hosts).toEqual(["https://a.test", "https://z.test"]);
      expect(catalog.updatedAt).toBe(chat.app.now.value);
      expect(catalog.description).toContain("https://a.test, https://z.test");
      expect(initial.description).not.toContain("https://a.test");
      first.script.reply("done");
      for (let i = 0; i < 100 && chat.app.runner.registry.size > 0; i++) {
        await tick();
      }
      const second = await startChat(chat, "second");
      const offered = chat.app.runner.registry
        .get(second.sessionId)!
        .policy.offered.tools.find((tool) => tool.name === "visualize")!;
      expect(catalog.tokens).toBe(wireTokens([offered]));
      expect(catalog.description).toBe(offered.description);
      expect(catalog.parameters).toEqual(offered.parameters);
      expect(second.script.body.tools).toContainEqual({
        type: "function",
        function: offered,
      });
      second.script.reply("done");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("empty hosts persist and settings on other tools are refused atomically", async () => {
    const chat = await chatApp();
    try {
      const saved = await chat.admin.call("PATCH", "/api/tools/visualize", {
        body: { hosts: [] },
      });
      expect(saved.status).toBe(200);
      const body: ToolsResponse = await saved.json();
      expect(body.visualize).toMatchObject({
        hosts: [],
        description: expect.stringContaining("inline only"),
      });
      const reload: ToolsResponse = await (
        await chat.admin.call("GET", "/api/tools")
      ).json();
      expect(reload.visualize).toEqual(body.visualize);
      // the host rules are the parseHosts table; here a refusal saves nothing
      const refusedHosts = await chat.admin.call(
        "PATCH",
        "/api/tools/visualize",
        { body: { hosts: ["https://assets.test/path"], enabled: false } },
      );
      expect(refusedHosts.status).toBe(400);
      expect((await refusedHosts.json()).error).toContain("hosts");
      for (const name of ["webfetch", "datetime", "websearch", "web"]) {
        const refused = await chat.admin.call("PATCH", `/api/tools/${name}`, {
          body: { hosts: [], enabled: false },
        });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({
          error:
            name === "webfetch" || name === "datetime"
              ? "no such tool"
              : "unknown field hosts",
        });
      }
      const provider = await chat.admin.call("PATCH", "/api/tools/visualize", {
        body: { provider: "exa" },
      });
      expect(provider.status).toBe(400);
      expect(await provider.json()).toEqual({
        error: "unknown field provider",
      });
      const after: ToolsResponse = await (
        await chat.admin.call("GET", "/api/tools")
      ).json();
      expect(after.visualize).toEqual(body.visualize);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the switch and the model tools flag gate visualize", async () => {
    const chat = await chatApp();
    try {
      const disabled = await chat.admin.call("PATCH", "/api/tools/visualize", {
        body: { enabled: false },
      });
      expect(disabled.status).toBe(200);
      const start = await startChat(chat, "disabled");
      expect(
        chat.app.runner.registry
          .get(start.sessionId)
          ?.policy.offered.tools.map((tool) => tool.name),
      ).not.toContain("visualize");
      start.script.reply("done");
      expect(
        (
          await chat.admin.call("PATCH", "/api/tools/visualize", {
            body: { enabled: true },
          })
        ).status,
      ).toBe(200);
      const agentId = await chat.makeAgent({ name: "plain", model: NO_TOOLS });
      const plain = await startChat(
        chat,
        "no tools",
        chat.member,
        chat.projectId,
        agentId,
      );
      expect(
        chat.app.runner.registry.get(plain.sessionId)?.policy.offered.tools,
      ).toEqual([]);
      expect(plain.script.body.tools).toBeUndefined();
      plain.script.reply("done");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("visual limits round-trip with exact bounds and are snapshotted", async () => {
    const chat = await chatApp();
    try {
      const initial = await (
        await chat.admin.call("GET", "/api/limits")
      ).json();
      expect(initial.limits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "visualBytes",
            default: 256 * 1024,
            min: 16 * 1024,
            max: 512 * 1024,
            scope: "visuals",
            unit: "bytes",
          }),
          expect.objectContaining({
            name: "visualSendBytes",
            default: 1024 * 1024,
            min: 64 * 1024,
            max: 4 * 1024 * 1024,
            scope: "visuals",
            unit: "bytes",
          }),
          expect.objectContaining({
            name: "maxVisuals",
            default: 2,
            min: 1,
            max: 10,
            scope: "visuals",
            unit: "count",
          }),
        ]),
      );
      const first = await startChat(chat, "old caps");
      const active = chat.app.runner.registry.get(first.sessionId)!;
      const values = {
        ...DEFAULT_LIMITS,
        visualBytes: 16 * 1024,
        visualSendBytes: 64 * 1024,
      };
      const saved = await chat.admin.call("PUT", "/api/limits", {
        body: { values },
      });
      expect(saved.status).toBe(200);
      expect(active.policy.toolCaps).toMatchObject({
        visualBytes: DEFAULT_LIMITS.visualBytes,
        visualSendBytes: DEFAULT_LIMITS.visualSendBytes,
      });
      first.script.reply("done");
      const second = await startChat(chat, "new caps");
      expect(
        chat.app.runner.registry.get(second.sessionId)?.policy.toolCaps,
      ).toMatchObject({
        visualBytes: values.visualBytes,
        visualSendBytes: values.visualSendBytes,
      });
      second.script.reply("done");
      for (const [name, min, max] of [
        ["visualBytes", 16 * 1024, 512 * 1024],
        ["visualSendBytes", 64 * 1024, 4 * 1024 * 1024],
      ] as const) {
        for (const value of [min - 1, max + 1]) {
          expect(
            (
              await chat.admin.call("PUT", "/api/limits", {
                body: { values: { ...values, [name]: value } },
              })
            ).status,
          ).toBe(400);
        }
        expect(
          (
            await chat.admin.call("PUT", "/api/limits", {
              body: { values: { ...values, [name]: max } },
            })
          ).status,
        ).toBe(200);
      }
    } finally {
      await chat.app.shutdown();
    }
  });
});
