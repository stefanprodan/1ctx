// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, spyOn, test } from "bun:test";
import { MCP_MESSAGES_PER_MINUTE } from "../../../src/server/mcp-server/index.ts";
import { collectLogs } from "../../helpers/app.ts";
import { fixture, json, legacy, modern, project, toolCall } from "./helper.ts";

describe("the inbound MCP server and transport", () => {
  test("serves 2025 initialize, notifications, ping and a closing stream", async () => {
    const { area, send } = fixture();
    const initialized = await send(
      legacy({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "old", version: "1" },
        },
      }),
    );
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    const stream = await initialized.text();
    expect(stream).toContain('"protocolVersion":"2025-03-26"');
    expect(stream).toContain('"name":"1ctx"');
    expect(stream).toContain('"listChanged":false');

    const notice = await send(
      legacy({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notice.status).toBe(202);
    const ping = await send(
      legacy({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
    );
    expect(await ping.text()).toContain('"result":{}');
    await area.close();
  });

  test("discovers 2026 tools, accepts notifications and rejects resources", async () => {
    const { area, send } = fixture();
    const discovered = await json(await send(modern("server/discover")));
    expect(discovered.result.supportedVersions).toEqual(["2026-07-28"]);
    expect(discovered.result.capabilities.tools.listChanged).toBe(false);
    expect(discovered.result.capabilities.resources).toBeUndefined();

    const resources = await json(await send(modern("resources/list")));
    expect(resources.error.code).toBe(-32601);
    for (const method of [
      "notifications/cancelled",
      "notifications/roots/list_changed",
    ]) {
      const response = await send(modern(method, {}, { id: -1 }));
      expect(response.status).toBe(202);
    }
    await area.close();
  });

  test.serial(
    "answers a 2026 tool call as JSON without a warning",
    async () => {
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      const { area, send } = fixture();
      try {
        const response = await send(
          modern(
            "tools/call",
            { name: "projects", arguments: { action: "list" } },
            { name: "projects" },
          ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toStartWith(
          "application/json",
        );
        await response.json();
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        await area.close();
      }
    },
  );

  test("acknowledges an unsupported subscription and closes it", async () => {
    const { area, send } = fixture();
    const response = await send(
      modern("subscriptions/listen", { notifications: {} }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("notifications/subscriptions/acknowledged");
    expect(body).toContain('"resultType":"complete"');
    await area.close();
  });

  test("answers GET and DELETE with 405", async () => {
    const { area, send } = fixture();
    for (const method of ["GET", "DELETE"]) {
      const response = await send(
        new Request("http://1ctx.test/mcp", { method }),
      );
      expect(response.status).toBe(405);
    }
    await area.close();
  });

  test("counts every member of a legacy batch against the key limit", async () => {
    const { area, send } = fixture();
    for (let id = 1; id <= MCP_MESSAGES_PER_MINUTE - 2; id++) {
      expect((await send(modern("server/discover", {}, { id }))).status).toBe(
        200,
      );
    }
    await expect(
      send(
        legacy([
          { jsonrpc: "2.0", id: 201, method: "ping", params: {} },
          { jsonrpc: "2.0", id: 202, method: "ping", params: {} },
          { jsonrpc: "2.0", id: 203, method: "ping", params: {} },
        ]),
      ),
    ).rejects.toMatchObject({ status: 429 });
    await area.close();
  });
  test("a read key advertises no write actions and refuses a forged one", async () => {
    const { area, send, state } = fixture();
    const listed = await json(await send(modern("tools/list")));
    const knowledge = listed.result.tools.find(
      (tool: any) => tool.name === "knowledge",
    );
    expect(knowledge.inputSchema.properties.action.enum).toEqual([
      "list",
      "search",
      "read",
      "versions",
      "version",
    ]);
    expect(knowledge.description).not.toMatch(
      /write|scope|create|edit|replace|rename|delete/i,
    );
    expect(knowledge.inputSchema.properties.prefix).toBeDefined();
    expect(knowledge.inputSchema.properties.since).toBeDefined();
    expect(knowledge.inputSchema.properties.readAt).toBeDefined();
    expect(knowledge.inputSchema.properties.offset).toBeDefined();
    expect(knowledge.inputSchema.properties.limit).toBeDefined();
    expect(knowledge.inputSchema.properties.outline).toBeDefined();
    expect(knowledge.inputSchema.properties.skip).toBeDefined();
    expect(knowledge.inputSchema.properties.revision).toBeDefined();
    expect(knowledge.description).toContain("optional offset and limit");
    expect(knowledge.description).toContain("optional folder prefix");
    expect(knowledge.description).toContain("optional ISO 8601 since");
    expect(knowledge.description).toContain("match needs every word");
    expect(knowledge.description).toContain("double quotes make a phrase");
    expect(Object.keys(knowledge.inputSchema.properties)).not.toContain("name");
    expect(Object.keys(knowledge.inputSchema.properties)).not.toContain("text");
    expect(Object.keys(knowledge.inputSchema.properties)).not.toContain(
      "edits",
    );
    const sessions = listed.result.tools.find(
      (tool: any) => tool.name === "sessions",
    );
    expect(sessions.inputSchema.properties.action.enum).toEqual([
      "search",
      "list",
      "read",
    ]);
    expect(sessions.inputSchema.properties.projectId).toBeDefined();
    expect(sessions.inputSchema.properties.q).toBeDefined();
    expect(sessions.inputSchema.properties.since).toBeDefined();
    expect(sessions.inputSchema.properties.readAt).toBeDefined();
    expect(sessions.inputSchema.properties.position).toBeDefined();
    expect(sessions.inputSchema.properties.offset).toBeUndefined();
    expect(sessions.description).toContain("match needs every word");
    expect(sessions.description).toContain("double quotes make a phrase");
    expect(sessions.description).toContain("after and readAt");
    expect(sessions.description).toContain("Children carry parentSessionId");
    expect(sessions.description).toContain("Take sessionId from a row");
    const refused = await toolCall(send, "knowledge", {
      action: "rename",
      projectId: project.id,
      fileId: "file00000001",
      name: "new.md",
    });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toBe("this access key is read-only");
    expect(state.writes).toHaveLength(0);
    await area.close();
  });
  test("contains and logs an unexpected tool error", async () => {
    const logs = collectLogs();
    const { area, send, state } = fixture(
      "read",
      logs.logFactory("mcp-server"),
    );
    state.readError = new Error("database detail");
    const answer = await toolCall(send, "knowledge", {
      action: "read",
      projectId: project.id,
      fileId: "file00000001",
    });
    expect(answer.result).toEqual({
      content: [{ type: "text", text: "internal error" }],
      isError: true,
      resultType: "complete",
      _meta: expect.any(Object),
    });
    expect(JSON.stringify(answer.result)).not.toContain("database detail");
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      level: "error",
      msg: "mcp call",
      fields: {
        tool: "knowledge",
        action: "read",
        status: 500,
        error: "database detail",
        error_type: "Error",
      },
    });
    await area.close();
  });
});
