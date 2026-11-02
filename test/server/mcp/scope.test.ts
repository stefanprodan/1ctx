// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where an MCP server is offered: the rule on fixtures, then every
// surface of the area and the tools' offer over one bound server.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import { mcpArea } from "../../../src/server/mcp/index.ts";
import { switchedOff } from "../../../src/server/tools/builtin/automation-switches.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import { mcpKey } from "../../../src/shared/capabilities.ts";
import { inScope } from "../../../src/shared/mcp.ts";
import { fakeFetch } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";
import { link, NO_PROJECTS, seedServer } from "./switches.helpers.ts";

describe("inScope", () => {
  test("all, a list with and without the project, a personal one, none", () => {
    expect(inScope({ scope: "all", projectIds: [] }, "personal1")).toBe(true);
    expect(inScope({ scope: "all", projectIds: [] }, "team1")).toBe(true);
    const listed = { scope: "projects" as const, projectIds: ["team1"] };
    expect(inScope(listed, "team1")).toBe(true);
    expect(inScope(listed, "team2")).toBe(false);
    // a list never holds a personal project
    expect(inScope(listed, "personal1")).toBe(false);
    expect(inScope({ scope: "projects", projectIds: [] }, "team1")).toBe(false);
  });
});

function setup() {
  const db = memoryDb();
  db.exec(`
    insert into users (id, username, full_name, email, role, password_hash, created_at)
      values ('u', 'casey', 'Casey', 'casey@example.com', 'member', 'x', 0);
    insert into projects (id, kind, name, owner_id, created_at)
      values ('personal1', 'personal', 'personal', 'u', 0),
             ('team1', 'team', 'finops', 'u', 0),
             ('team2', 'team', 'research', 'u', 0);
  `);
  const fetched = fakeFetch();
  const mcp = mcpArea({
    db,
    fetcher: fetched.fetcher,
    secret: () => null,
    keys: () => [],
    callTimeoutMs: () => 20_000,
    clock: () => 1,
    log: silent,
    version: "test",
    render: (text) => text,
    capabilities: { forget: () => {} },
    usage: {
      calls: () => ({ calls: 0, failed: 0, tools: [] }),
      servers: () => ({ calls: 0, failed: 0, servers: [] }),
    },
    ...NO_PROJECTS,
  });
  const markets = seedServer(mcp.store, "markets");
  const docs = seedServer(mcp.store, "docs");
  mcp.store.setScope(markets.id, ["team1"]);
  const links = [link(markets), link(docs)];
  const tools = toolsArea({
    db,
    fetcher: fetched.fetcher,
    secret: () => null,
    clock: () => 1,
    log: silent,
    render: (text) => text,
    skills: { forAgent: () => [], body: () => null, file: () => null },
    mcp,
  });
  return { db, mcp, tools, markets, docs, links };
}

const scope = (projectId: string, phase: "main" | "child" = "main") => ({
  projectId,
  automation: null,
  phase,
  origin: "chat" as const,
});

describe("a bound server's offer", () => {
  test("a send in a bound project gets it, another or a personal one does not", async () => {
    const { db, mcp, tools, links } = setup();
    try {
      const names = (projectId: string, phase?: "main" | "child") =>
        tools
          .offered(1, "", links, "all", scope(projectId, phase))
          .mcp.map((server) => server.name);
      expect(names("team1")).toEqual(["docs", "markets"]);
      expect(names("team2")).toEqual(["docs"]);
      expect(names("personal1")).toEqual(["docs"]);
      // a subagent's offer follows its parent's project
      expect(names("team1", "child")).toEqual(["docs", "markets"]);
      expect(names("team2", "child")).toEqual(["docs"]);
      const out = tools.offered(1, "", links, "all", scope("team2"));
      expect(JSON.stringify(out.tools)).not.toContain("mcp__markets__");
      expect(out.mcpPrompt.text).not.toContain("markets");
      const catalog = tools.offered(1, "", links, "catalog", scope("team2"));
      expect(catalog.mcpCatalog).not.toContain("mcp__markets__");
    } finally {
      await mcp.close();
      db.close();
    }
  });

  test("an emptied list offers it nowhere, all everywhere again", async () => {
    const { db, mcp, tools, markets, links } = setup();
    try {
      const names = (projectId: string) =>
        tools
          .offered(1, "", links, "all", scope(projectId))
          .mcp.map((server) => server.name);
      mcp.store.setScope(markets.id, []);
      expect(mcp.store.byId(markets.id)).toMatchObject({
        scope: "projects",
        projectIds: [],
      });
      expect(names("team1")).toEqual(["docs"]);
      mcp.store.setScope(markets.id, "all");
      expect(names("personal1")).toEqual(["docs", "markets"]);
    } finally {
      await mcp.close();
      db.close();
    }
  });

  test("the switchable lists and the off names leave it out", async () => {
    const { db, mcp, tools, markets, docs, links } = setup();
    try {
      expect(mcp.switchable(links, "team1").map((s) => s.name)).toEqual([
        "docs",
        "markets",
      ]);
      expect(mcp.switchable(links, "personal1").map((s) => s.name)).toEqual([
        "docs",
      ]);
      expect(mcp.switchableBy([{ id: "a1", servers: links }], "team2")).toEqual(
        { a1: [{ id: docs.id, name: "docs", tools: 1 }] },
      );
      expect(tools.serverNames(links, "team2")).toEqual(["docs"]);
      expect(tools.serverNames(links, "team1")).toEqual(["docs", "markets"]);
      expect(
        mcp.scopes().map(({ name, scope, projectIds }) => ({
          name,
          scope,
          projectIds,
        })),
      ).toEqual([
        { name: "docs", scope: "all", projectIds: [] },
        { name: "markets", scope: "projects", projectIds: ["team1"] },
      ]);
      // a project deleted leaves the server's other links
      mcp.store.setScope(markets.id, ["team1", "team2"]);
      db.exec("delete from projects where id = 'team1'");
      expect(mcp.store.byId(markets.id)?.projectIds).toEqual(["team2"]);
      db.exec("delete from projects where id = 'team2'");
      expect(mcp.store.byId(markets.id)).toMatchObject({
        scope: "projects",
        projectIds: [],
      });
    } finally {
      await mcp.close();
      db.close();
    }
  });

  test("an automation's key for a server out of scope is skipped silently", () => {
    const names = {
      servers: [{ id: "docs1", name: "docs" }],
      serversOut: ["markets1"],
      skills: [],
      credentials: [],
      repos: [],
    };
    expect(switchedOff([mcpKey("markets1"), mcpKey("docs1")], names)).toEqual([
      "MCP server docs",
    ]);
    // one the agent no longer links is still no longer available
    expect(switchedOff([mcpKey("gone1")], names)).toEqual([
      "an item no longer available",
    ]);
  });
});
