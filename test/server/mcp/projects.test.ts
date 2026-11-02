// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server bound to team projects, through the composed app: the
// sends, the composer's lists, a project's Settings list and its
// writes, the agent directory and the admin's create and patch.

import { describe, expect, test } from "bun:test";
import type { McpProjects } from "../../../src/shared/api/mcp.ts";
import { automationBody, startRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  sessionSettled,
  startChat,
} from "../../helpers/chat.ts";
import { mcpFetch } from "./fake.ts";

const tool = {
  name: "get_portfolio",
  description: "Read the portfolio.",
  inputSchema: { type: "object", properties: {} },
};

async function team(chat: ChatApp, name: string, member = true) {
  const created = await chat.admin.call("POST", "/api/projects", {
    body: { name, description: "A team project." },
  });
  expect(created.status).toBe(201);
  const id = (await created.json()).project.id as string;
  if (member) {
    const added = await chat.admin.call("POST", `/api/projects/${id}/members`, {
      body: { userId: chat.memberId },
    });
    expect(added.status).toBe(201);
  }
  return id;
}

function server(chat: ChatApp, name: string, projects: McpProjects) {
  return chat.app.mcp.create(
    {
      name,
      url: `http://${name}.test/mcp`,
      keyName: null,
      read: true,
      write: false,
      instructionsOn: false,
      timeoutMs: null,
      readPatterns: ["*"],
      writePatterns: [],
      excludedPatterns: [],
      projects,
    },
    {
      serverName: name,
      serverVersion: "1",
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      instructions: "",
      fingerprint: name,
      checkedAt: 1,
      tools: [
        {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          schemaJson: JSON.stringify(tool.inputSchema),
          unusable: null,
        },
      ],
    },
  );
}

// a chat's first round's MCP tool names, the reply closed
async function offeredIn(chat: ChatApp, projectId: string) {
  const { script, sessionId } = await startChat(
    chat,
    "hi",
    chat.member,
    projectId,
  );
  const names = ((script.body.tools ?? []) as { function: { name: string } }[])
    .map((tool) => tool.function.name)
    .filter((name) => name.startsWith("mcp__"));
  script.reply("ok");
  await sessionSettled(chat.app, sessionId);
  return names;
}

async function bound() {
  const chat = await chatApp();
  const finops = await team(chat, "finops");
  const research = await team(chat, "research");
  const hidden = await team(chat, "hidden", false);
  const markets = server(chat, "markets", [finops]);
  const docs = server(chat, "docs", "all");
  const secret = server(chat, "secret", [hidden]);
  chat.app.mcp.setAgentServers(chat.agentId, [
    { serverId: markets.id, read: true, write: false },
    { serverId: docs.id, read: true, write: false },
    { serverId: secret.id, read: true, write: false },
  ]);
  return { chat, finops, research, hidden, markets, docs, secret };
}

describe("a bound server's sends", () => {
  test("a chat and a run in a bound project get it, others do not", async () => {
    const { chat, finops, research } = await bound();
    try {
      expect(await offeredIn(chat, finops)).toEqual([
        "mcp__docs__get_portfolio",
        "mcp__markets__get_portfolio",
      ]);
      expect(await offeredIn(chat, research)).toEqual([
        "mcp__docs__get_portfolio",
      ]);
      expect(await offeredIn(chat, chat.projectId)).toEqual([
        "mcp__docs__get_portfolio",
      ]);
      const created = await chat.member.call(
        "POST",
        `/api/projects/${finops}/automations`,
        { body: automationBody(chat) },
      );
      expect(created.status).toBe(201);
      const { automation } = await created.json();
      const { sessionId, main } = await startRun(chat, automation.id);
      expect(JSON.stringify(main.body.tools)).toContain("mcp__markets__");
      main.reply("done");
      await sessionSettled(chat.app, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the composer's lists leave an out of scope server out", async () => {
    const { chat, finops, research, markets, docs } = await bound();
    try {
      const listed = async (projectId: string) => {
        const res = await chat.member.call(
          "GET",
          `/api/projects/${projectId}/agents`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        const agent = body.agents.find(
          (row: { id: string }) => row.id === chat.agentId,
        );
        return {
          links: agent.servers.map(
            (link: { serverId: string }) => link.serverId,
          ),
          servers: body.servers[chat.agentId].map(
            (row: { name: string }) => row.name,
          ),
        };
      };
      expect(await listed(finops)).toEqual({
        links: expect.arrayContaining([markets.id, docs.id]),
        servers: ["docs", "markets"],
      });
      const other = await listed(research);
      expect(other).toEqual({ links: [docs.id], servers: ["docs"] });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a project's MCP list", () => {
  test("a member sees its servers without a URL or key; others get a 404", async () => {
    const { chat, finops, hidden } = await bound();
    try {
      const res = await chat.member.call("GET", `/api/projects/${finops}/mcp`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.servers.map((row: { name: string }) => row.name)).toEqual([
        "docs",
        "markets",
      ]);
      expect(body.servers[1]).toEqual({
        id: expect.any(String),
        name: "markets",
        tools: 1,
        scope: "projects",
      });
      expect(JSON.stringify(body)).not.toContain("markets.test");
      expect(body.addable).toEqual([]);
      expect(
        (await chat.member.call("GET", `/api/projects/${hidden}/mcp`)).status,
      ).toBe(404);
      const personal = await (
        await chat.member.call("GET", `/api/projects/${chat.projectId}/mcp`)
      ).json();
      expect(personal).toEqual({
        servers: [
          { id: expect.any(String), name: "docs", tools: 1, scope: "all" },
        ],
        addable: [],
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an admin adds and removes a bound server; all is changed on its page", async () => {
    const { chat, finops, research, markets, docs, secret } = await bound();
    const nowhere = server(chat, "nowhere", []);
    try {
      const list = async () =>
        (await chat.admin.call("GET", `/api/projects/${research}/mcp`)).json();
      expect((await list()).addable).toEqual([
        { id: markets.id, name: "markets" },
        { id: nowhere.id, name: "nowhere" },
        { id: secret.id, name: "secret" },
      ]);
      expect(
        (
          await chat.member.call("POST", `/api/projects/${research}/mcp`, {
            body: { serverId: markets.id },
          })
        ).status,
      ).toBe(403);
      const added = await chat.admin.call(
        "POST",
        `/api/projects/${research}/mcp`,
        { body: { serverId: markets.id } },
      );
      expect(added.status).toBe(201);
      expect(
        (await added.json()).servers.map((row: { name: string }) => row.name),
      ).toEqual(["docs", "markets"]);
      expect(chat.app.mcp.byId(markets.id)?.projectIds.sort()).toEqual(
        [finops, research].sort(),
      );
      expect(
        (
          await chat.admin.call("POST", `/api/projects/${research}/mcp`, {
            body: { serverId: markets.id },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await chat.admin.call("POST", `/api/projects/${research}/mcp`, {
            body: { serverId: docs.id },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await chat.admin.call(
            "DELETE",
            `/api/projects/${research}/mcp/${docs.id}`,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await chat.admin.call(
            "DELETE",
            `/api/projects/${chat.projectId}/mcp/${markets.id}`,
          )
        ).status,
      ).toBe(404);
      for (const projectId of [research, finops]) {
        expect(
          (
            await chat.admin.call(
              "DELETE",
              `/api/projects/${projectId}/mcp/${markets.id}`,
            )
          ).status,
        ).toBe(204);
      }
      // the last one removed: offered nowhere, never widened
      expect(chat.app.mcp.byId(markets.id)).toMatchObject({
        scope: "projects",
        projectIds: [],
      });
      expect(await offeredIn(chat, finops)).toEqual([
        "mcp__docs__get_portfolio",
      ]);
      expect(
        (
          await chat.admin.call(
            "DELETE",
            `/api/projects/${finops}/mcp/${markets.id}`,
          )
        ).status,
      ).toBe(404);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("deleting a bound project keeps the server's other links", async () => {
    const { chat, finops, research, markets } = await bound();
    try {
      chat.app.mcp.setScope(markets.id, [finops, research]);
      expect(
        (await chat.admin.call("DELETE", `/api/projects/${research}`)).status,
      ).toBe(200);
      expect(chat.app.mcp.byId(markets.id)?.projectIds).toEqual([finops]);
      expect(
        (await chat.admin.call("DELETE", `/api/projects/${finops}`)).status,
      ).toBe(200);
      expect(chat.app.mcp.byId(markets.id)).toMatchObject({
        scope: "projects",
        projectIds: [],
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("the agent directory", () => {
  test("a member sees what they can reach; an admin sees every server", async () => {
    const { chat, markets, docs } = await bound();
    try {
      const read = async (client = chat.member) => {
        const res = await client.call("GET", "/api/directory/agents/coder");
        expect(res.status).toBe(200);
        return res.json();
      };
      const member = await read();
      expect(member.mcp.servers).toEqual([
        expect.objectContaining({ name: "docs", scope: "all", projects: [] }),
        expect.objectContaining({
          name: "markets",
          scope: "projects",
          projects: ["finops"],
        }),
      ]);
      expect(
        member.agent.servers.map((link: { serverId: string }) => link.serverId),
      ).toEqual(expect.arrayContaining([docs.id, markets.id]));
      expect(member.agent.servers).toHaveLength(2);
      expect(JSON.stringify(member)).not.toContain("secret");
      const admin = await read(chat.admin);
      expect(
        admin.mcp.servers.map((row: { name: string }) => row.name),
      ).toEqual(["docs", "markets", "secret"]);
      expect(admin.mcp.servers[2]).toMatchObject({
        scope: "projects",
        projects: ["hidden"],
      });
      expect(admin.agent.servers).toHaveLength(3);
      // the hidden server's schema is in neither of the member's totals
      expect(admin.mcp.tokens).toBeGreaterThan(member.mcp.tokens);
      expect(admin.tokens.tools).toBeGreaterThan(member.tokens.tools);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("the admin's server routes", () => {
  test("a create and a patch take projects, team ones only", async () => {
    const markets = mcpFetch({
      recorded: {
        initialize: {
          serverInfo: { name: "markets", version: "1" },
          capabilities: { tools: {} },
        },
        tools: { tools: [tool] },
      },
    });
    const chat = await chatApp({
      fetcher: markets.fetcher,
      secrets: { "mcp-markets": "markets-secret" },
    });
    try {
      const finops = await team(chat, "finops");
      const body = {
        name: "markets",
        url: "http://markets.test/mcp",
        keyName: "mcp-markets",
        read: true,
        write: false,
        instructionsOn: false,
        timeoutMs: null,
        readPatterns: ["*"],
        writePatterns: [],
        excludedPatterns: [],
      };
      expect((await chat.admin.call("POST", "/api/mcp", { body })).status).toBe(
        400,
      );
      expect(
        (
          await chat.admin.call("POST", "/api/mcp", {
            body: { ...body, projects: [chat.projectId] },
          })
        ).status,
      ).toBe(400);
      const created = await chat.admin.call("POST", "/api/mcp", {
        body: { ...body, projects: [finops] },
      });
      expect(created.status).toBe(201);
      const { server: made } = await created.json();
      expect(made).toMatchObject({
        scope: "projects",
        projects: [{ id: finops, name: "finops" }],
      });
      // a key moved keeps the scope
      const moved = await chat.admin.call("PATCH", `/api/mcp/${made.id}`, {
        body: { keyName: null },
      });
      expect(moved.status).toBe(200);
      expect((await moved.json()).server.projects).toEqual([
        { id: finops, name: "finops" },
      ]);
      const widened = await chat.admin.call("PATCH", `/api/mcp/${made.id}`, {
        body: { projects: "all" },
      });
      expect((await widened.json()).server).toMatchObject({
        scope: "all",
        projects: [],
      });
      expect(
        (
          await chat.admin.call("PATCH", `/api/mcp/${made.id}`, {
            body: { projects: ["nosuchproject"] },
          })
        ).status,
      ).toBe(400);
      const listed = await (await chat.admin.call("GET", "/api/mcp")).json();
      expect(listed.servers[0].scope).toBe("all");
    } finally {
      await chat.app.shutdown();
    }
  });
});
