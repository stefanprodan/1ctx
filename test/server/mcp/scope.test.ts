// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where an MCP server is offered: the rule on fixtures, then every
// surface of the area and the tools' offer over the project's choices.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import { mcpArea } from "../../../src/server/mcp/index.ts";
import { switchedOff } from "../../../src/server/tools/builtin/automation-switches.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import { mcpKey } from "../../../src/shared/capabilities.ts";
import type { McpSide } from "../../../src/shared/contracts/mcp.ts";
import {
  ceilingOf,
  type Granted,
  offeredSide,
} from "../../../src/shared/mcp.ts";
import { fakeFetch } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";
import { NO_PROJECTS, seedProject, seedServer } from "./switches.helpers.ts";

const TEAM = { id: "team1", kind: "team" as const };
const OTHER = { id: "team2", kind: "team" as const };
const PERSONAL = { id: "personal1", kind: "personal" as const };
const CHOICES: (McpSide | null)[] = [null, "off", "read", "write"];

const granted = (fields: Partial<Granted>): Granted => ({
  scope: "all",
  projectIds: [],
  personal: "off",
  read: true,
  write: true,
  ...fields,
});

describe("offeredSide", () => {
  test("a team grant: all, a list with and without the project, empty", () => {
    const all = granted({});
    const listed = granted({ scope: "projects", projectIds: ["team1"] });
    const empty = granted({ scope: "projects", projectIds: [] });
    for (const server of [all, listed]) {
      expect(CHOICES.map((c) => offeredSide(server, TEAM, c))).toEqual([
        "read",
        "off",
        "read",
        "write",
      ]);
    }
    for (const [server, project] of [
      [listed, OTHER],
      [empty, TEAM],
    ] as const) {
      expect(ceilingOf(server, project)).toBe("off");
      expect(CHOICES.map((c) => offeredSide(server, project, c))).toEqual([
        "off",
        "off",
        "off",
        "off",
      ]);
    }
  });

  test("a personal grant is the personal project's ceiling", () => {
    const side = (personal: McpSide) =>
      CHOICES.map((c) => offeredSide(granted({ personal }), PERSONAL, c));
    expect(side("off")).toEqual(["off", "off", "off", "off"]);
    expect(side("read")).toEqual(["read", "off", "read", "read"]);
    expect(side("write")).toEqual(["read", "off", "read", "write"]);
  });

  test("a team project never reads the personal grant, nor a personal one the team grant", () => {
    const teamOnly = granted({ scope: "all", personal: "off" });
    expect(offeredSide(teamOnly, PERSONAL, "write")).toBe("off");
    const personalOnly = granted({
      scope: "projects",
      projectIds: [],
      personal: "write",
    });
    expect(offeredSide(personalOnly, TEAM, "write")).toBe("off");
    expect(offeredSide(personalOnly, PERSONAL, "write")).toBe("write");
  });

  test("the server's switches: Write off caps, Read off with Write on", () => {
    const readOnly = granted({ write: false, personal: "write" });
    expect(ceilingOf(readOnly, TEAM)).toBe("read");
    expect(ceilingOf(readOnly, PERSONAL)).toBe("read");
    expect(CHOICES.map((c) => offeredSide(readOnly, TEAM, c))).toEqual([
      "read",
      "off",
      "read",
      "read",
    ]);
    // a Read choice gives nothing, a Read and write one the write tools
    const writeOnly = granted({ read: false, personal: "write" });
    for (const project of [TEAM, PERSONAL]) {
      expect(CHOICES.map((c) => offeredSide(writeOnly, project, c))).toEqual([
        "off",
        "off",
        "off",
        "write",
      ]);
    }
    const neither = granted({ read: false, write: false });
    expect(CHOICES.map((c) => offeredSide(neither, TEAM, c))).toEqual([
      "off",
      "off",
      "off",
      "off",
    ]);
  });
});

function setup() {
  const db = memoryDb();
  seedProject(db, "personal1", "personal");
  seedProject(db, "team1");
  seedProject(db, "team2");
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
  const markets = seedServer(mcp.store, "markets", 1, true);
  const docs = seedServer(mcp.store, "docs");
  mcp.store.setScope(markets.id, ["team1"]);
  mcp.store.setPersonal(markets.id, "off");
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
  return { db, mcp, tools, markets, docs };
}

const scope = (projectId: string | null, phase: "main" | "child" = "main") => ({
  projectId,
  automation: null,
  phase,
  origin: "chat" as const,
});

type Setup = ReturnType<typeof setup>;
const offer = (
  { tools }: Setup,
  projectId: string | null,
  options: { phase?: "main" | "child"; on?: boolean; off?: string[] } = {},
) =>
  tools.offered(
    1,
    "",
    options.on ?? true,
    "all",
    scope(projectId, options.phase),
    options.off ?? [],
  );
const names = (out: ReturnType<typeof offer>) =>
  out.mcp.map((server) => server.name);
const wires = (out: ReturnType<typeof offer>) =>
  out.mcp.flatMap((server) => server.tools.map((tool) => tool.wireName));

describe("the project's offer", () => {
  test("a granted server is on, read only, until the project chooses", async () => {
    const s = setup();
    try {
      expect(names(offer(s, "team1"))).toEqual(["docs", "markets"]);
      expect(names(offer(s, "team2"))).toEqual(["docs"]);
      // a list never holds a personal project, a personal grant decides
      expect(names(offer(s, "personal1"))).toEqual(["docs"]);
      expect(wires(offer(s, "team1"))).not.toContain("mcp__markets__set_item");
      s.mcp.store.setChoice("team1", s.markets.id, "write");
      expect(wires(offer(s, "team1"))).toContain("mcp__markets__set_item");
      s.mcp.store.setChoice("team1", s.docs.id, "off");
      const out = offer(s, "team1");
      expect(names(out)).toEqual(["markets"]);
      expect(JSON.stringify(out.tools)).not.toContain("mcp__docs__");
      expect(out.mcpPrompt.text).not.toContain("docs");
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("a child under a write choice gets the read side only", async () => {
    const s = setup();
    try {
      s.mcp.store.setChoice("team1", s.markets.id, "write");
      const child = offer(s, "team1", { phase: "child" });
      expect(names(child)).toEqual(["docs", "markets"]);
      expect(wires(child)).toContain("mcp__markets__get_item0");
      expect(wires(child)).not.toContain("mcp__markets__set_item");
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("an agent off MCP gets none, its child none, and no project none", async () => {
    const s = setup();
    try {
      expect(names(offer(s, "team1", { on: false }))).toEqual([]);
      expect(names(offer(s, "team1", { on: false, phase: "child" }))).toEqual(
        [],
      );
      expect(names(offer(s, null))).toEqual([]);
      expect(names(offer(s, "missing"))).toEqual([]);
      expect(s.tools.offered(1, "").mcp).toEqual([]);
      // only the directory's sides are taken as given
      const chosen = s.tools.offered(1, "", true, "all", {
        ...scope(null),
        mcpSides: [{ serverId: s.markets.id, side: "write" }],
      });
      expect(names(chosen)).toEqual(["markets"]);
      expect(wires(chosen)).toContain("mcp__markets__set_item");
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("a chat's switch drops a server from the offer", async () => {
    const s = setup();
    try {
      const out = offer(s, "team1", { off: [mcpKey(s.docs.id)] });
      expect(names(out)).toEqual(["markets"]);
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("a lowered ceiling caps the offer and raising it restores the choice", async () => {
    const s = setup();
    try {
      s.mcp.store.setChoice("team1", s.markets.id, "write");
      s.mcp.store.updateSettings(s.markets.id, { write: false });
      expect(wires(offer(s, "team1"))).not.toContain("mcp__markets__set_item");
      expect(names(offer(s, "team1"))).toContain("markets");
      s.mcp.store.updateSettings(s.markets.id, { write: true });
      expect(wires(offer(s, "team1"))).toContain("mcp__markets__set_item");
      // a personal grant lowered and raised again likewise
      s.mcp.store.setScope(s.markets.id, "all");
      s.mcp.store.setPersonal(s.markets.id, "write");
      s.mcp.store.setChoice("personal1", s.markets.id, "write");
      expect(wires(offer(s, "personal1"))).toContain("mcp__markets__set_item");
      s.mcp.store.setPersonal(s.markets.id, "read");
      expect(wires(offer(s, "personal1"))).not.toContain(
        "mcp__markets__set_item",
      );
      s.mcp.store.setPersonal(s.markets.id, "write");
      expect(wires(offer(s, "personal1"))).toContain("mcp__markets__set_item");
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("an emptied list offers it nowhere, all in every team project again", async () => {
    const s = setup();
    try {
      s.mcp.store.setScope(s.markets.id, []);
      expect(s.mcp.store.byId(s.markets.id)).toMatchObject({
        scope: "projects",
        projectIds: [],
      });
      expect(names(offer(s, "team1"))).toEqual(["docs"]);
      s.mcp.store.setScope(s.markets.id, "all");
      expect(names(offer(s, "team2"))).toEqual(["docs", "markets"]);
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("the switchable lists and the off names follow the choices", async () => {
    const s = setup();
    try {
      expect(s.mcp.switchable("team1").map((x) => x.name)).toEqual([
        "docs",
        "markets",
      ]);
      expect(s.mcp.switchable("team2")).toEqual([
        { id: s.docs.id, name: "docs", tools: 1 },
      ]);
      s.mcp.store.setChoice("team1", s.docs.id, "off");
      expect(s.mcp.switchable("team1").map((x) => x.name)).toEqual(["markets"]);
      const off = [mcpKey(s.docs.id), mcpKey(s.markets.id)];
      expect(s.tools.serverNames("team1", off)).toEqual(["markets"]);
      expect(s.tools.serverNames("team2", off)).toEqual(["docs"]);
      expect(s.mcp.sides("team1")).toEqual([
        { serverId: s.markets.id, side: "read" },
      ]);
      // a project deleted takes its choices and leaves the other links
      s.mcp.store.setScope(s.markets.id, ["team1", "team2"]);
      s.db.exec("delete from projects where id = 'team1'");
      expect(s.mcp.store.byId(s.markets.id)?.projectIds).toEqual(["team2"]);
      expect(s.db.query("select count(*) as n from project_mcp").get()).toEqual(
        { n: 0 },
      );
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("where a server is on: team projects by id, personal as a count", async () => {
    const s = setup();
    try {
      seedProject(s.db, "personal2", "personal");
      s.mcp.store.setChoice("personal2", s.docs.id, "off");
      const on = s.mcp.whereOn();
      expect([...(on.get(s.docs.id)?.teams.keys() ?? [])].sort()).toEqual([
        "team1",
        "team2",
      ]);
      expect(on.get(s.docs.id)?.personal).toBe(1);
      expect(on.get(s.docs.id)?.widest).toBe("read");
      expect([...(on.get(s.markets.id)?.teams.keys() ?? [])]).toEqual([
        "team1",
      ]);
      // a list server's personal grant is its own field
      expect(on.get(s.markets.id)?.personal).toBe(0);
      s.mcp.store.setPersonal(s.markets.id, "read");
      expect(s.mcp.whereOn().get(s.markets.id)?.personal).toBe(2);
    } finally {
      await s.mcp.close();
      s.db.close();
    }
  });

  test("an automation's key for a server not offered is skipped silently", () => {
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
    // one that no longer exists is still no longer available
    expect(switchedOff([mcpKey("gone1")], names)).toEqual([
      "an item no longer available",
    ]);
  });
});
