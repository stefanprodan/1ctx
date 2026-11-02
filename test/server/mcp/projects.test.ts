// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP server granted to projects and chosen by each, through the
// composed app: the sends, the composer's lists, a project's Settings
// list and its writes, the choice routes, the agent directory and the
// admin's create, patch and delete.

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

// a list server is kept out of personal projects, as a keyed one is
function server(
  chat: ChatApp,
  name: string,
  projects: McpProjects,
  write = false,
) {
  return chat.app.mcp.create(
    {
      name,
      url: `http://${name}.test/mcp`,
      keyName: null,
      read: true,
      write,
      instructionsOn: false,
      timeoutMs: null,
      readPatterns: ["*"],
      writePatterns: [],
      excludedPatterns: [],
      projects,
      personal: projects === "all" ? "read" : "off",
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
  return { chat, finops, research, hidden, markets, docs, secret };
}

describe("a granted server's sends", () => {
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

  test("the composer's list is the project's, and empty for an agent off MCP", async () => {
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
          mcp: agent.mcp,
          servers: body.servers.map((row: { name: string }) => row.name),
        };
      };
      expect(await listed(finops)).toEqual({
        mcp: true,
        servers: ["docs", "markets"],
      });
      expect(await listed(research)).toEqual({ mcp: true, servers: ["docs"] });
      chat.app.mcp.setChoice(finops, docs.id, "off");
      expect((await listed(finops)).servers).toEqual(["markets"]);
      expect(markets.id).not.toBe(docs.id);
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
      const sides = { choice: "read", ceiling: "read", side: "read" };
      // a member never learns how many projects a list holds
      expect(body.servers[1]).toEqual({
        id: expect.any(String),
        name: "markets",
        tools: 1,
        scope: "projects",
        read: true,
        ...sides,
      });
      const admin = await (
        await chat.admin.call("GET", `/api/projects/${finops}/mcp`)
      ).json();
      expect(admin.servers).toEqual([
        {
          id: expect.any(String),
          name: "docs",
          tools: 1,
          scope: "all",
          read: true,
          ...sides,
        },
        {
          id: expect.any(String),
          name: "markets",
          tools: 1,
          scope: "projects",
          read: true,
          ...sides,
          projects: 1,
        },
      ]);
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
          {
            id: expect.any(String),
            name: "docs",
            tools: 1,
            scope: "all",
            read: true,
            ...sides,
          },
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
      // each answers the list, the server gone from it
      for (const projectId of [research, finops]) {
        const removed = await chat.admin.call(
          "DELETE",
          `/api/projects/${projectId}/mcp/${markets.id}`,
        );
        expect(removed.status).toBe(200);
        expect(
          (await removed.json()).servers.map(
            (row: { name: string }) => row.name,
          ),
        ).toEqual(["docs"]);
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
  test("a member sees what is on where they can see; an admin sees every server", async () => {
    const { chat, finops, docs } = await bound();
    try {
      const read = async (client = chat.member) => {
        const res = await client.call("GET", "/api/directory/agents/coder");
        expect(res.status).toBe(200);
        return res.json();
      };
      const member = await read();
      expect(member.mcp.servers).toEqual([
        expect.objectContaining({
          name: "docs",
          projects: ["finops", "Personal", "research"],
          personal: 0,
        }),
        expect.objectContaining({
          name: "markets",
          projects: ["finops"],
          personal: 0,
        }),
      ]);
      expect(member.agent.mcp).toBe(true);
      expect(JSON.stringify(member)).not.toContain("secret");
      const admin = await read(chat.admin);
      expect(
        admin.mcp.servers.map((row: { name: string }) => row.name),
      ).toEqual(["docs", "markets", "secret"]);
      // every team project by name, personal ones as a count
      expect(admin.mcp.servers[0]).toMatchObject({
        projects: ["finops", "hidden", "research"],
        personal: 2,
      });
      expect(admin.mcp.servers[2]).toMatchObject({
        projects: ["hidden"],
        personal: 0,
      });
      // the hidden server's schema is in neither of the member's totals
      expect(admin.mcp.tokens).toBeGreaterThan(member.mcp.tokens);
      expect(admin.tokens.tools).toBeGreaterThan(member.tokens.tools);
      // an off choice drops a project's name
      chat.app.mcp.setChoice(finops, docs.id, "off");
      expect((await read()).mcp.servers[0].projects).toEqual([
        "Personal",
        "research",
      ]);
      // an agent off MCP lists none and counts none
      chat.app.db.exec(
        `update agents set mcp_on = 0 where id = '${chat.agentId}'`,
      );
      const off = await read(chat.admin);
      expect(off.mcp).toEqual({ servers: [], tokens: 0 });
      expect(off.tokens.tools).toBeLessThan(admin.tokens.tools);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a project's choice", () => {
  test("an admin sets a team project's side; a member's PUT is a 403", async () => {
    const { chat, finops, research, markets, docs } = await bound();
    const editor = server(chat, "editor", [finops], true);
    try {
      const put = (
        client: typeof chat.admin,
        projectId: string,
        serverId: string,
        side: string,
      ) =>
        client.call("PUT", `/api/projects/${projectId}/mcp/${serverId}/side`, {
          body: { side },
        });
      expect((await put(chat.member, finops, docs.id, "off")).status).toBe(403);
      const off = await put(chat.admin, finops, docs.id, "off");
      expect(off.status).toBe(200);
      expect(
        (await off.json()).servers.find(
          (row: { name: string }) => row.name === "docs",
        ),
      ).toMatchObject({ choice: "off", side: "off" });
      expect(await offeredIn(chat, finops)).not.toContain(
        "mcp__docs__get_portfolio",
      );
      // above the ceiling, not granted, a personal project, an unknown side
      expect((await put(chat.admin, finops, markets.id, "write")).status).toBe(
        400,
      );
      expect((await put(chat.admin, research, markets.id, "read")).status).toBe(
        404,
      );
      expect(
        (await put(chat.admin, chat.projectId, docs.id, "off")).status,
      ).toBe(404);
      expect((await put(chat.admin, finops, docs.id, "all")).status).toBe(400);
      expect((await put(chat.admin, finops, editor.id, "write")).status).toBe(
        200,
      );
      expect(chat.app.mcp.choices(finops)?.sides.get(editor.id)).toBe("write");
      // read is the default, held as no row
      expect((await put(chat.admin, finops, docs.id, "read")).status).toBe(200);
      expect(chat.app.mcp.choices(finops)?.sides.has(docs.id)).toBe(false);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an owner sets their personal project's side, nobody reaches another's", async () => {
    const { chat, docs, markets } = await bound();
    try {
      const put = (client: typeof chat.admin, serverId: string, side: string) =>
        client.call("PUT", `/api/profile/project/mcp/${serverId}/side`, {
          body: { side },
        });
      const res = await put(chat.member, docs.id, "off");
      expect(res.status).toBe(200);
      expect((await res.json()).servers[0]).toMatchObject({
        name: "docs",
        choice: "off",
      });
      expect(await offeredIn(chat, chat.projectId)).toEqual([]);
      // the admin's own personal project is another one
      expect((await put(chat.admin, docs.id, "read")).status).toBe(200);
      expect(chat.app.mcp.choices(chat.projectId)?.sides.get(docs.id)).toBe(
        "off",
      );
      // a list server is not granted to a personal project
      expect((await put(chat.member, markets.id, "read")).status).toBe(404);
      // until its personal grant is on, and then it reads all there
      chat.app.mcp.setPersonal(markets.id, "read");
      const granted = await put(chat.member, markets.id, "read");
      expect(granted.status).toBe(200);
      expect(
        (await granted.json()).servers.map(
          (s: { name: string; scope: string }) => [s.name, s.scope],
        ),
      ).toEqual([
        ["docs", "all"],
        ["markets", "all"],
      ]);
      // the personal grant is the ceiling
      expect((await put(chat.member, docs.id, "write")).status).toBe(400);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a server delete with grants and choices succeeds and cascades", async () => {
    const { chat, finops, markets } = await bound();
    try {
      chat.app.mcp.setChoice(finops, markets.id, "off");
      expect(
        (await chat.admin.call("DELETE", `/api/mcp/${markets.id}`)).status,
      ).toBe(204);
      expect(chat.app.mcp.choices(finops)?.sides.size).toBe(0);
      expect(chat.app.mcp.byId(markets.id)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the server's GET says where it is on", async () => {
    const { chat, finops, research, docs } = await bound();
    try {
      chat.app.mcp.setChoice(research, docs.id, "off");
      const { servers } = await (
        await chat.admin.call("GET", "/api/mcp")
      ).json();
      const row = servers.find((s: { name: string }) => s.name === "docs");
      expect(row.personal).toBe("read");
      expect(row.on).toEqual({
        projects: [
          { id: finops, name: "finops" },
          { id: expect.any(String), name: "hidden" },
        ],
        personal: 2,
      });
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
      // a key needs personal as it needs projects
      expect(
        (
          await chat.admin.call("POST", "/api/mcp", {
            body: { ...body, projects: [finops] },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await chat.admin.call("POST", "/api/mcp", {
            body: { ...body, projects: [chat.projectId], personal: "off" },
          })
        ).status,
      ).toBe(400);
      const created = await chat.admin.call("POST", "/api/mcp", {
        body: { ...body, projects: [finops], personal: "off" },
      });
      expect(created.status).toBe(201);
      const { server: made } = await created.json();
      expect(made).toMatchObject({
        scope: "projects",
        projects: [{ id: finops, name: "finops" }],
        personal: "off",
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
        body: { projects: "all", personal: "write" },
      });
      expect((await widened.json()).server).toMatchObject({
        scope: "all",
        projects: [],
        personal: "write",
      });
      expect(
        (
          await chat.admin.call("PATCH", `/api/mcp/${made.id}`, {
            body: { personal: "some" },
          })
        ).status,
      ).toBe(400);
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
