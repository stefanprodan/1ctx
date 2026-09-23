// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The whole path of a kept MCP result: a call in a chat answers past the
// cut, the tool row carries the start and the path, the rows are written
// with it, and a bash command of the next round reads the file.

import { expect, test } from "bun:test";
import { settleRun } from "../../helpers/automations.ts";
import { chatApp, startChat, waitScript } from "../../helpers/chat.ts";
import { mcpFetch } from "../mcp/fake.ts";

const manifests = Array.from(
  { length: 4000 },
  (_, i) => `---\nkind: Deployment\nmetadata:\n  name: app-${i}\n`,
).join("");

test("an MCP answer past the cut is read back from /mcp in the chat", async () => {
  const flux = mcpFetch({
    recorded: {
      initialize: {
        serverInfo: { name: "flux", version: "1" },
        capabilities: { tools: {} },
      },
      tools: {
        tools: [
          {
            name: "get_kubernetes_resources",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    },
    callResult: {
      content: [
        { type: "text", text: manifests },
        {
          type: "resource",
          resource: { uri: "x://flux/notes.md", text: "# kept\n" },
        },
      ],
    },
  });
  const chat = await chatApp({ fetcher: flux.fetcher });
  const created = await chat.admin.call("POST", "/api/mcp", {
    body: {
      name: "flux",
      url: "http://flux.test/mcp",
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
      mcpMode: "all",
    },
  });
  expect(saved.status).toBe(200);

  const first = await startChat(chat, "list the deployments");
  first.script.toolRound([
    { id: "get", name: "mcp__flux__get_kubernetes_resources", arguments: "{}" },
  ]);
  first.script.end();
  const second = await waitScript(chat.scripted, 2);
  second.toolRound([
    {
      id: "read",
      name: "bash",
      arguments: JSON.stringify({
        command:
          "yq '.metadata.name' /mcp/0001-get_kubernetes_resources/result.txt | tail -1; cat /mcp/0001-get_kubernetes_resources/notes.md",
      }),
    },
  ]);
  second.end();
  const answer = await waitScript(chat.scripted, 3);
  answer.reply("There are 4000 deployments.");
  await settleRun(chat, first.sessionId);

  const rows = chat.app.sessions.messages(first.sessionId);
  const call = rows.find((row) => row.toolCallId === "get")!;
  const full = chat.app.sessions.message(call.id)!;
  expect(call.status).toBe("done");
  expect(full.content).toMatch(
    /\nwhole result: \/mcp\/0001-get_kubernetes_resources\/result\.txt, 16,002 lines, 186 KB: query it with yq, rg or sed\nsaved: \/mcp\/0001-get_kubernetes_resources\/notes\.md$/,
  );
  expect(full.content.length).toBeLessThanOrEqual(50_000);
  // the model's next request carries the start and the path, not the whole
  const request = JSON.stringify(second.body.messages);
  expect(request).toContain("whole result: /mcp/0001-get_kubernetes_resources");
  expect(request).not.toContain("app-3999");

  const read = rows.find((row) => row.toolCallId === "read")!;
  const printed = chat.app.sessions.message(read.id)!.content;
  expect(printed).toContain("app-3999");
  expect(printed).toContain("# kept");

  const kept = chat.app.db
    .query<{ name: string; folder: number }, [string]>(
      "select name, folder from mcp_kept_files where message_id = ? order by position",
    )
    .all(call.id);
  expect(kept).toEqual([
    { name: "notes.md", folder: 1 },
    { name: "result.txt", folder: 1 },
  ]);
  expect(
    chat.app.db
      .query<{ mcp_folders: number }, [string]>(
        "select mcp_folders from sessions where id = ?",
      )
      .get(first.sessionId),
  ).toEqual({ mcp_folders: 1 });

  // regenerate drops the row and its files; the number is not given again
  chat.app.db
    .query("delete from messages where session_id = ? and seq > 1")
    .run(first.sessionId);
  expect(
    chat.app.db.query("select count(*) as n from mcp_kept_files").get(),
  ).toEqual({ n: 0 });
  expect(chat.app.knowledge.startKept(first.sessionId).next).toBe(2);
});
