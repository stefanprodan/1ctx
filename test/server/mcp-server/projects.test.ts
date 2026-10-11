// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createKey } from "../../helpers/access-keys.ts";
import { startChat, waitScript } from "../../helpers/chat.ts";
import {
  childrenOf,
  delegateCall,
  settled,
  subagentApp,
} from "../../helpers/subagents.ts";
import { fixture, META, project, toolCall } from "./helper.ts";

describe("the inbound MCP project boundary", () => {
  test("does not search or list sessions outside the key scope", async () => {
    const { area, send, state } = fixture();
    state.reachable = [];
    await toolCall(send, "sessions", {
      action: "search",
      projectId: project.id,
      q: "missing words",
    });
    await toolCall(send, "sessions", {
      action: "list",
      projectId: project.id,
    });
    expect(state.sessionCalls).toEqual([]);
    await area.close();
  });

  test("MCP reads a found child only through its project", async () => {
    const chat = await subagentApp();
    try {
      const delegated = async (projectId: string, word: string) => {
        const before = chat.scripted.scripts.length;
        const { script, sessionId } = await startChat(
          chat,
          `survey ${word}`,
          chat.member,
          projectId,
        );
        script.toolRound([
          delegateCall("delegate-1", `Find the ${word} notes.`),
        ]);
        script.end();
        const child = await waitScript(chat.scripted, before + 2);
        child.reply(`${word}: the child found three things`);
        const parent = await waitScript(chat.scripted, before + 3);
        parent.reply("done");
        await settled(chat, sessionId);
        return childrenOf(chat, sessionId)[0]!;
      };

      const childId = await delegated(chat.projectId, "zebrafeedback");
      const created = await chat.admin.call("POST", "/api/projects", {
        body: { name: "hidden-team", description: "A hidden team project." },
      });
      expect(created.status).toBe(201);
      const hiddenProject = (await created.json()).project;
      const joined = await chat.admin.call(
        "POST",
        `/api/projects/${hiddenProject.id}/members`,
        { body: { userId: chat.memberId } },
      );
      expect(joined.status).toBe(201);
      const hiddenChildId = await delegated(hiddenProject.id, "hiddenfeedback");
      const accessKey = await createKey(chat.member, {
        scope: "read",
        projectIds: [chat.projectId],
      });
      const client = chat.app.client();
      let id = 0;
      const call = async (args: unknown) => {
        const response = await client.call("POST", "/mcp", {
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name: "sessions", arguments: args, _meta: META },
          }),
          headers: {
            authorization: `Bearer ${accessKey.token}`,
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "sessions",
          },
        });
        expect(response.status).toBe(200);
        return (await response.json()).result;
      };

      const found = await call({
        action: "search",
        projectId: chat.projectId,
        q: "zebrafeedback three",
      });
      expect(found.content[0].text).toContain(`"id":"${childId}"`);
      const read = await call({ action: "read", sessionId: childId });
      expect(read.isError).toBeUndefined();
      expect(read.content.at(-1).text).toContain(
        "zebrafeedback: the child found three things",
      );
      const pageRead = await chat.member.call(
        "GET",
        `/api/sessions/${childId}`,
      );
      expect(pageRead.status).toBe(404);

      const hidden = await call({
        action: "read",
        sessionId: hiddenChildId,
      });
      expect(hidden.isError).toBe(true);
      expect(hidden.content[0].text).toBe("no such chat");
    } finally {
      await chat.app.shutdown();
    }
  });
});
