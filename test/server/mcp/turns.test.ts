// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A server bound to one team project, through every kind of chat turn
// that is not a plain message: a channel turn, an agent summoned into a
// chat and a queued message dispatched later. Each takes its session's
// project, so the server's tools reach the provider in the bound
// project alone.

import { describe, expect, test } from "bun:test";
import { settleRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  FLASH,
  freed,
  idle,
  type Script,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";

const schema = { type: "object", properties: {} };

async function bound() {
  const chat = await chatApp();
  const finops = (await createTeam(chat.admin, "finops", [chat.memberId])).id;
  const research = (await createTeam(chat.admin, "research", [chat.memberId]))
    .id;
  const checker = await chat.makeAgent({ name: "checker", model: FLASH });
  const markets = chat.app.mcp.create(
    {
      name: "markets",
      url: "http://markets.test/mcp",
      keyName: null,
      read: true,
      write: false,
      instructionsOn: false,
      timeoutMs: null,
      readPatterns: ["*"],
      writePatterns: [],
      excludedPatterns: [],
      projects: [finops],
    },
    {
      serverName: "markets",
      serverVersion: "1",
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      instructions: "",
      fingerprint: "markets",
      checkedAt: 1,
      tools: [
        {
          name: "get_portfolio",
          description: "Read the portfolio.",
          inputSchema: schema,
          schemaJson: JSON.stringify(schema),
          unusable: null,
        },
      ],
    },
  );
  for (const agentId of [chat.agentId, checker]) {
    chat.app.mcp.setAgentServers(agentId, [
      { serverId: markets.id, read: true, write: false },
    ]);
  }
  return { chat, finops, research };
}

// the MCP tools the provider received
const mcpTools = (script: Script) =>
  ((script.body.tools ?? []) as { function: { name: string } }[])
    .map((tool) => tool.function.name)
    .filter((name) => name.startsWith("mcp__"));

const post = (chat: ChatApp, sessionId: string, message: string) =>
  chat.member.call("POST", `/api/sessions/${sessionId}/messages`, {
    body: { message },
  });

describe("turns outside a bound server's scope", () => {
  test("a channel turn gets its tools in the bound project alone", async () => {
    const { chat, finops, research } = await bound();
    try {
      for (const [projectId, expected] of [
        [finops, ["mcp__markets__get_portfolio"]],
        [research, []],
      ] as const) {
        const channelId = chat.app.db
          .query<{ id: string }, [string]>(
            "select id from sessions where project_id = ? and origin = 'channel' and parent_session_id is null",
          )
          .get(projectId)!.id;
        const count = chat.scripted.scripts.length;
        expect((await post(chat, channelId, "@coder check this")).status).toBe(
          201,
        );
        const script = await waitScript(chat.scripted, count + 1);
        expect(mcpTools(script)).toEqual([...expected]);
        script.reply("checked");
        await idle(chat.app);
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an agent summoned into a chat gets them in the bound project alone", async () => {
    const { chat, finops, research } = await bound();
    try {
      for (const [projectId, expected] of [
        [finops, ["mcp__markets__get_portfolio"]],
        [research, []],
      ] as const) {
        const started = await startChat(chat, "hi", chat.member, projectId);
        started.script.reply("hello");
        await settleRun(chat, started.sessionId);
        await freed(chat.app, started.sessionId);
        const count = chat.scripted.scripts.length;
        const response = await post(
          chat,
          started.sessionId,
          "@checker is that right",
        );
        expect(response.status).toBe(201);
        const summoned = await waitScript(chat.scripted, count + 1);
        expect(mcpTools(summoned)).toEqual([...expected]);
        summoned.reply("yes");
        await settleRun(chat, started.sessionId);
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a queued message dispatched later gets them in the bound project alone", async () => {
    const { chat, finops, research } = await bound();
    try {
      for (const [projectId, expected] of [
        [finops, ["mcp__markets__get_portfolio"]],
        [research, []],
      ] as const) {
        const started = await startChat(
          chat,
          "long one",
          chat.member,
          projectId,
        );
        const count = chat.scripted.scripts.length;
        expect((await post(chat, started.sessionId, "and then")).status).toBe(
          202,
        );
        started.script.reply("done");
        const queued = await waitScript(chat.scripted, count + 1);
        expect(mcpTools(queued)).toEqual([...expected]);
        queued.reply("then done");
        await settleRun(chat, started.sessionId);
      }
    } finally {
      await chat.app.shutdown();
    }
  });
});
