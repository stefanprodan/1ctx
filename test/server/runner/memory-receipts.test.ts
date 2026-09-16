// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ToolCall } from "../../../src/shared/contracts/tool.ts";
import incident from "../../fixtures/memory/incident.json";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import { mcpFetch } from "../mcp/fake.ts";

async function setup(mode: "all" | "catalog") {
  const flux = mcpFetch({
    recorded: {
      initialize: {
        serverInfo: { name: "incident-tools", version: "1" },
        capabilities: { tools: {} },
      },
      tools: {
        tools: incident.toolNames.map((name) => ({
          name,
          inputSchema: {
            type: "object",
            properties: {
              kind: { type: "string" },
              name: { type: "string" },
              namespace: { type: "string" },
            },
          },
        })),
      },
    },
    callResult: {
      content: [{ type: "text", text: "TOOL_RESULT_MUST_NOT_APPEAR" }],
    },
    mutateResult(method, result, body) {
      const params = body.params as { name?: string } | undefined;
      return method === "tools/call" && params?.name === "get_kubernetes_logs"
        ? {
            ...result,
            isError: true,
            content: [{ type: "text", text: "TOOL_ERROR_MUST_NOT_APPEAR" }],
          }
        : result;
    },
  });
  const chat = await chatApp({ fetcher: flux.fetcher });
  const created = await chat.admin.call("POST", "/api/mcp", {
    body: {
      name: "flux",
      url: "http://flux.test/mcp",
      keyName: null,
      read: true,
      write: true,
      instructionsOn: false,
      timeoutMs: null,
      readPatterns: incident.readPatterns,
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
      servers: [{ serverId: server.id, read: true, write: true }],
      mcpMode: mode,
    },
  });
  expect(saved.status).toBe(200);
  const wire = (call: ToolCall): ToolCall =>
    mode === "all"
      ? call
      : {
          ...call,
          name: "mcp_call",
          arguments: JSON.stringify({
            name: call.name,
            arguments: JSON.parse(call.arguments),
          }),
        };
  const source = await startChat(chat, incident.rows[0]!.content);
  source.script.content("WORK_MUST_NOT_APPEAR");
  source.script.toolRound(incident.rows[1]!.toolCalls!.map(wire));
  source.script.end();
  const fix = await waitScript(chat.scripted, 2);
  fix.toolRound([wire(incident.rows[4]!.toolCalls![0]!)]);
  fix.end();
  const answer = await waitScript(chat.scripted, 3);
  answer.reply(incident.rows.at(-1)!.content!);
  await settleRun(chat, source.sessionId);
  return { chat, serverId: server.id, sourceId: source.sessionId };
}

async function readChat(chat: ChatApp, automationId: string, sourceId: string) {
  const run = await startRun(chat, automationId);
  const count = chat.scripted.scripts.length;
  run.main.toolRound([
    { id: "list", name: "sessions_list", arguments: "{}" },
    {
      id: "read",
      name: "session_read",
      arguments: JSON.stringify({ id: sourceId }),
    },
  ]);
  run.main.end();
  const edit = await waitScript(chat.scripted, count + 1);
  const results = chat.app.sessions.messages(run.sessionId);
  const read = results.find((row) => row.toolCallId === "read")!;
  expect(read.status).toBe("done");
  expect(JSON.stringify(edit.body.messages)).toContain("Tools:");
  const handle = chat.app.runner.registry.get(run.sessionId)!.policy.offered
    .memory!;
  expect(handle.read!.pending.get(sourceId)).toBe(
    chat.app.sessions.byId(sourceId)!.lastActivityAt,
  );
  edit.toolRound([
    { id: "keep", name: "memory_edit", arguments: '{"action":"none"}' },
  ]);
  edit.end();
  const finish = await waitScript(chat.scripted, count + 2);
  finish.reply("Chat reviewed.");
  await settleRun(chat, run.sessionId);
  expect(
    chat.app.db
      .query<{ read_activity_at: number }, [string, string]>(
        `select read_activity_at from automation_memory_reads
         where automation_id = ? and session_id = ?`,
      )
      .get(automationId, sourceId)?.read_activity_at,
  ).toBe(chat.app.sessions.byId(sourceId)!.lastActivityAt);
  return read.content;
}

describe("memory task tool receipts", () => {
  test.each(["all", "catalog"] as const)(
    "session_read carries %s MCP calls without their results and leaves Download unchanged",
    async (mode) => {
      const { chat, sourceId } = await setup(mode);
      try {
        const automation = await createAutomation(chat, {
          projectMemory: true,
        });
        const text = await readChat(chat, automation.id, sourceId);
        const expected = incident.receipts.slice(0, 3);
        if (mode === "catalog") {
          expected[0] =
            '- mcp__flux__get_kubernetes_resources {"kind":"Pod","namespace":"checkout"} : done';
        }
        expect(text).toContain(`Tools:\n${expected.join("\n")}`);
        expect(text).toContain(incident.rows.at(-1)!.content!);
        expect(text).toEndWith(
          "Chat read. Record what matters with memory_edit action set, or action none when there is nothing, before reading the next chat.",
        );
        for (const forbidden of incident.absent) {
          expect(text).not.toContain(forbidden);
        }
        const download = await chat.member.call(
          "GET",
          `/api/sessions/${sourceId}/markdown?tz=UTC`,
        );
        expect(download.status).toBe(200);
        const markdown = await download.text();
        expect(markdown).not.toContain("Tools:");
        expect(markdown).not.toContain("mcp__");
        expect(markdown).toContain(incident.rows.at(-1)!.content!);
        for (const forbidden of incident.absent) {
          expect(markdown).not.toContain(forbidden);
        }
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("uses current patterns, including exclusion and read precedence, and forgets deleted servers", async () => {
    const { chat, serverId, sourceId } = await setup("all");
    try {
      const automation = await createAutomation(chat, { projectMemory: true });
      for (const settings of [
        { readPatterns: ["*"], writePatterns: ["*"], excludedPatterns: [] },
        { readPatterns: [], writePatterns: ["*"], excludedPatterns: ["*"] },
        { readPatterns: [], writePatterns: ["missing"], excludedPatterns: [] },
      ]) {
        expect(
          (
            await chat.admin.call("PATCH", `/api/mcp/${serverId}`, {
              body: settings,
            })
          ).status,
        ).toBe(200);
        expect(await readChat(chat, automation.id, sourceId)).not.toContain(
          "(write)",
        );
      }
      chat.app.mcp.setAgentServers(chat.agentId, []);
      expect(
        (await chat.admin.call("DELETE", `/api/mcp/${serverId}`)).status,
      ).toBe(204);
      const text = await readChat(chat, automation.id, sourceId);
      expect(text).toContain("mcp__flux__delete_kubernetes_resource");
      expect(text).not.toContain("(write)");
    } finally {
      await chat.app.shutdown();
    }
  });
});
