// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Subagents at once: two overlap, a third waits for one to end, the
// second takes an extra stream of the registry's, and with sendsRunning
// full it runs after its sibling. And the MCP write side never reaches
// a child.

import { describe, expect, test } from "bun:test";
import {
  type ChatApp,
  setLimits,
  startChat,
  tick,
} from "../../helpers/chat.ts";
import {
  childFor,
  delegateCall,
  isChild,
  scriptsFrom,
  settled,
  subagentApp,
  system,
  toolNames,
} from "../../helpers/subagents.ts";
import { seedServer } from "../mcp/switches.helpers.ts";

const children = (chat: ChatApp) => chat.scripted.scripts.filter(isChild);

// a few turns of the loop with nothing new arriving
async function quiet(chat: ChatApp, count: number) {
  for (let i = 0; i < 40; i++) await tick();
  expect(chat.scripted.scripts.length).toBe(count);
}

describe("subagents at once", () => {
  test("two overlap, the second on an extra stream, a third waits for one to end", async () => {
    const chat = await subagentApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([
        delegateCall("d1", "task alpha"),
        delegateCall("d2", "task beta"),
        delegateCall("d3", "task gamma"),
      ]);
      script.end();
      // both started before either answered
      const started = await scriptsFrom(chat, 3);
      const alpha = childFor(started, "alpha");
      const beta = childFor(started, "beta");
      expect(chat.app.runner.registry.extraStreams).toBe(1);
      await quiet(chat, 3);
      beta.reply("beta done");
      const third = await scriptsFrom(chat, 4);
      const gamma = childFor(third, "gamma");
      expect(chat.app.runner.registry.extraStreams).toBe(1);
      alpha.reply("alpha done");
      gamma.reply("gamma done");
      const after = await scriptsFrom(chat, 5);
      const parent = after[4]!;
      expect(isChild(parent)).toBe(false);
      const results = (
        parent.body.messages as { role: string; content: string }[]
      ).filter((m) => m.role === "tool");
      expect(results.map((m) => m.content)).toEqual([
        "alpha done",
        "beta done",
        "gamma done",
      ]);
      expect(chat.app.runner.registry.extraStreams).toBe(0);
      parent.reply("all done");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("with sendsRunning full the second runs after its sibling", async () => {
    const chat = await subagentApp();
    try {
      await setLimits(chat, {
        sendsPerUser: 4,
        sendsPerProject: 4,
        sendsRunning: 4,
      });
      const others = [];
      for (let i = 0; i < 3; i++)
        others.push(await startChat(chat, `other ${i}`));
      const { script, sessionId } = await startChat(chat, "the parent");
      script.toolRound([
        delegateCall("d1", "task alpha"),
        delegateCall("d2", "task beta"),
      ]);
      script.end();
      const first = await scriptsFrom(chat, 5);
      expect(isChild(first[4]!)).toBe(true);
      await quiet(chat, 5);
      expect(chat.app.runner.registry.extraStreams).toBe(0);
      first[4]!.reply("first done");
      const second = await scriptsFrom(chat, 6);
      expect(isChild(second[5]!)).toBe(true);
      second[5]!.reply("second done");
      const parent = (await scriptsFrom(chat, 7))[6]!;
      expect(isChild(parent)).toBe(false);
      parent.reply("done");
      await settled(chat, sessionId);
      expect(children(chat)).toHaveLength(2);
      for (const other of others) {
        other.script.reply("done");
        await settled(chat, other.sessionId);
      }
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a subagent's MCP tools", () => {
  test("are the read side alone, in the schemas and the prompt", async () => {
    const chat = await subagentApp();
    try {
      const server = chat.app.mcp.create(
        {
          name: "flux",
          url: "https://flux.test/mcp",
          keyName: null,
          read: true,
          write: true,
          instructionsOn: true,
          timeoutMs: null,
          readPatterns: ["get_*"],
          writePatterns: [],
          excludedPatterns: [],
        },
        {
          serverName: "flux",
          serverVersion: "1",
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
          instructions: "Use flux carefully.",
          fingerprint: "flux",
          checkedAt: 1,
          tools: ["get_item", "set_item"].map((name) => ({
            name,
            description: `${name} an item.`,
            inputSchema: { type: "object", properties: {} },
            schemaJson: '{"type":"object","properties":{}}',
            unusable: null,
          })),
        },
      );
      seedServer(chat.app.mcp, "unused");
      const agent = chat.app.agents.byId(chat.agentId)!;
      const patched = await chat.admin.call(
        "PATCH",
        `/api/agents/${agent.id}`,
        {
          body: {
            name: agent.name,
            providerId: agent.providerId,
            model: agent.model.id,
            thinking: agent.thinking,
            effort: agent.effort,
            prompt: "",
            servers: [{ serverId: server.id, read: true, write: true }],
            mcpMode: "all",
            subagents: true,
          },
        },
      );
      expect(patched.status, await patched.text()).toBe(200);
      const { script, sessionId } = await startChat(chat);
      expect(toolNames(script)).toEqual(
        expect.arrayContaining(["mcp__flux__get_item", "mcp__flux__set_item"]),
      );
      script.toolRound([delegateCall("d1", "read flux")]);
      script.end();
      const child = (await scriptsFrom(chat, 2))[1]!;
      expect(isChild(child)).toBe(true);
      expect(toolNames(child)).toContain("mcp__flux__get_item");
      expect(toolNames(child)).not.toContain("mcp__flux__set_item");
      expect(system(child)).toContain("Use flux carefully.");
      child.reply("read it");
      (await scriptsFrom(chat, 3))[2]!.reply("done");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});
