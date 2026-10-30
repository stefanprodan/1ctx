// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { settleRun } from "../../helpers/automations.ts";
import { chatApp, startChat, waitScript } from "../../helpers/chat.ts";
import { mcpFetch } from "../mcp/fake.ts";

// a list written as JSON text reaches the server as a list, called by
// its own name or through mcp_call, and the row keeps what was sent
for (const mode of ["all", "catalog"] as const) {
  test(`a list sent as JSON text reaches the server as a list (${mode})`, async () => {
    const markets = mcpFetch({
      recorded: {
        initialize: {
          serverInfo: { name: "markets", version: "1" },
          capabilities: { tools: {} },
        },
        tools: {
          tools: [
            {
              name: "quote",
              inputSchema: {
                type: "object",
                properties: {
                  symbols: { type: "array", items: { type: "string" } },
                },
                required: ["symbols"],
              },
            },
          ],
        },
      },
    });
    const chat = await chatApp({ fetcher: markets.fetcher });
    const created = await chat.admin.call("POST", "/api/mcp", {
      body: {
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
      },
    });
    expect(created.status).toBe(201);
    const { server } = (await created.json()) as { server: { id: string } };
    const agent = chat.app.agents.byId(chat.agentId)!;
    const saved = await chat.admin.call("PATCH", `/api/agents/${agent.id}`, {
      body: {
        name: agent.name,
        providerId: agent.providerId,
        model: agent.model.id,
        thinking: agent.thinking,
        effort: agent.effort,
        servers: [{ serverId: server.id, read: true, write: false }],
        mcpMode: mode,
      },
    });
    expect(saved.status).toBe(200);

    const sent = { symbols: '["NVDA","TSM"]' };
    const first = await startChat(chat, "quote them");
    first.script.toolRound([
      mode === "all"
        ? {
            id: "q",
            name: "mcp__markets__quote",
            arguments: JSON.stringify(sent),
          }
        : {
            id: "q",
            name: "mcp_call",
            arguments: JSON.stringify({
              name: "mcp__markets__quote",
              arguments: sent,
            }),
          },
    ]);
    first.script.end();
    const answer = await waitScript(chat.scripted, 2);
    answer.reply("Quoted.");
    await settleRun(chat, first.sessionId);

    const calls = markets.requests.filter(
      (request) => request.body.method === "tools/call",
    );
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body.params as { arguments: unknown }).arguments).toEqual(
      { symbols: ["NVDA", "TSM"] },
    );
    const row = chat.app.sessions
      .messages(first.sessionId)
      .find((message) => message.toolCallId === "q")!;
    expect(row.status).toBe("done");
    const reply = chat.app.sessions
      .messages(first.sessionId)
      .find((message) => message.toolCalls?.some((call) => call.id === "q"))!;
    expect(reply.toolCalls![0]!.arguments).toContain('\\"NVDA\\"');
  });
}
