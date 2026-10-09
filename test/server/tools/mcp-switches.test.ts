// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { type Log, silent } from "../../../src/server/lib/log.ts";
import { type Mcp, mcpArea } from "../../../src/server/mcp/index.ts";
import { wireTokens } from "../../../src/server/providers/index.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import { mcpKey } from "../../../src/shared/capabilities.ts";
import { MCP_CATALOG_FROM_TOKENS } from "../../../src/shared/mcp-catalog.ts";
import { collectLogs, fakeFetch } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";
import { link, seedServer } from "../mcp/switches.helpers.ts";
import { context } from "./memory.helpers.ts";

const NO_USAGE = {
  calls: () => ({ calls: 0, failed: 0, tools: [] }),
  servers: () => ({ calls: 0, failed: 0, servers: [] }),
};

function setup(
  large = false,
  bash?: Parameters<typeof toolsArea>[0]["bash"],
  log: Log = silent,
  port?: (mcp: Mcp) => NonNullable<Parameters<typeof toolsArea>[0]["mcp"]>,
) {
  const db = memoryDb();
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
    usage: NO_USAGE,
  });
  const flux = seedServer(mcp.store, "flux", large ? 48 : 1);
  const docs = seedServer(mcp.store, "docs");
  const links = [link(flux), link(docs)];
  const tools = toolsArea({
    db,
    fetcher: fetched.fetcher,
    secret: () => null,
    clock: () => 1,
    log,
    render: (text) => text,
    skills: { forAgent: () => [], body: () => null, file: () => null },
    mcp: port === undefined ? mcp : port(mcp),
    bash,
    memory: {
      work: (projectId, automationId) => ({
        target: { projectId, automationId },
        baseRevision: 0,
        entries: [],
        operations: [],
        failedRounds: 0,
      }),
      edit: () => ({ error: false, content: "" }),
      refuse: (_projectId, _sessionId, reason) => reason,
    },
  });
  return { db, mcp, tools, flux, docs, links };
}

test.each(["all", "catalog"] as const)(
  "%s filters disabled links from every MCP surface and dispatch",
  async (mode) => {
    const { db, mcp, tools, flux, docs, links } = setup();
    try {
      const all = tools.offered(1, "", links, mode);
      const off = tools.offered(1, "", links, mode, undefined, [
        mcpKey(flux.id),
      ]);
      expect(all.mcp.map((server) => server.name)).toEqual(["docs", "flux"]);
      expect(off.mcp.map((server) => server.name)).toEqual(["docs"]);
      expect(off.mcpPrompt.digest).toEqual({
        docs: all.mcpPrompt.digest.docs,
      });
      expect(off.mcpPrompt.text).not.toContain("flux");
      expect(off.mcpPrompt.text).toContain("Use the docs server carefully.");
      expect(JSON.stringify(off.tools)).not.toContain("mcp__flux__");
      if (mode === "catalog") {
        expect(off.mcpCatalog).toContain("mcp__docs__get_item0");
        expect(off.mcpCatalog).not.toContain("mcp__flux__");
        for (const name of ["mcp_call", "mcp_describe"]) {
          expect(
            off.tools.find((tool) => tool.name === name)?.parameters,
          ).toMatchObject({
            properties: {
              name: {
                type: "string",
                description: "A tool name from the available MCP tools above.",
              },
            },
          });
        }
        expect(JSON.stringify(off.tools)).not.toContain("enum");
        // a disabled server's tool, an unprefixed name and an unknown one
        for (const name of [
          "mcp__flux__get_item0",
          "get_item0",
          "mcp__docs__nope",
        ]) {
          expect(
            await tools.run(
              off,
              {
                id: "catalog",
                name: "mcp_call",
                arguments: JSON.stringify({ name, arguments: {} }),
              },
              context(),
            ),
          ).toEqual({
            error: true,
            content: `Error: MCP tool ${name} is not available; use a name from the available MCP tools`,
          });
        }
      } else {
        expect(off.mcpCatalog).toBe("");
        expect(off.tools.map((tool) => tool.name)).toContain(
          "mcp__docs__get_item0",
        );
      }
      let calls = 0;
      mcp.call = async () => {
        calls++;
        throw new Error("disabled server was called");
      };
      expect(
        await tools.run(
          off,
          { id: "direct", name: "mcp__flux__get_item0", arguments: "{}" },
          context(),
        ),
      ).toEqual({
        error: true,
        content: 'Error: tool "mcp__flux__get_item0" not found.',
      });
      expect(calls).toBe(0);
      const none = tools.offered(1, "", links, mode, undefined, [
        mcpKey(flux.id),
        mcpKey(docs.id),
      ]);
      expect(none.mcp).toEqual([]);
      expect(none.mcpPrompt).toEqual({ text: "", digest: {} });
      expect(none.mcpCatalog).toBe("");
      expect(none.tools.some((tool) => tool.name.startsWith("mcp"))).toBe(
        false,
      );
    } finally {
      await mcp.close();
      db.close();
    }
  },
);

test("a tool outside the snapshot is refused though its row exists", async () => {
  const { db, mcp, tools, docs } = setup();
  try {
    const both = seedServer(mcp.store, "both", 2);
    // the server allows writes, so only the link keeps the write side out
    mcp.store.updateSettings(both.id, {
      write: true,
      readPatterns: ["get_item0"],
      writePatterns: ["get_item1"],
    });
    const call = (name: string) => ({
      id: "call",
      name: "mcp_call",
      arguments: JSON.stringify({ name, arguments: {} }),
    });
    const refused = (name: string) => ({
      error: true,
      content: `Error: MCP tool ${name} is not available; use a name from the available MCP tools`,
    });
    // the write side of a read-only link
    const read = tools.offered(1, "", [link(both), link(docs)], "catalog");
    expect(read.mcpCatalog).toContain("mcp__both__get_item0");
    expect(read.mcpCatalog).not.toContain("mcp__both__get_item1");
    expect(
      await tools.run(read, call("mcp__both__get_item1"), context()),
    ).toEqual(refused("mcp__both__get_item1"));
    // a subagent's links are read alone, whatever its parent's are
    const writes = [{ ...link(both), write: true }, link(docs)];
    expect(tools.offered(1, "", writes, "catalog").mcpCatalog).toContain(
      "mcp__both__get_item1",
    );
    const child = tools.offered(1, "", writes, "catalog", {
      projectId: null,
      automation: null,
      phase: "child",
    });
    expect(child.mcpCatalog).not.toContain("mcp__both__get_item1");
    expect(
      await tools.run(child, call("mcp__both__get_item1"), context()),
    ).toEqual(refused("mcp__both__get_item1"));
  } finally {
    await mcp.close();
    db.close();
  }
});

test("a catalog past its floor keeps every tool and logs the count alone", async () => {
  const logs = collectLogs();
  const { db, mcp, tools, docs } = setup(
    false,
    undefined,
    logs.logFactory("tools"),
  );
  try {
    const huge = seedServer(mcp.store, "huge", 900);
    const offer = tools.offered(1, "", [link(huge), link(docs)], "catalog");
    expect(offer.mcp.map((server) => server.name)).toEqual(["docs", "huge"]);
    expect(offer.mcpCatalog).toContain("\nmcp__huge__get_item899\n");
    expect(offer.mcpCatalog).toContain(
      "\ndocs (1 tool):\nmcp__docs__get_item0\n",
    );
    expect(Object.keys(offer.mcpPrompt.digest)).toEqual(["docs", "huge"]);
    expect(logs.events).toEqual([
      {
        level: "warn",
        area: "tools",
        msg: "catalog over cap",
        fields: { kind: "mcp", count: 901 },
      },
    ]);
  } finally {
    await mcp.close();
    db.close();
  }
});

test("a catalog with no tool to list offers neither catalog tool", async () => {
  // offeredServers drops a server with no tool, so the port strips them
  const { db, mcp, tools, links } = setup(false, undefined, silent, (m) => ({
    ...m,
    offered: (agentLinks) => {
      const offer = m.offered(agentLinks);
      return {
        ...offer,
        servers: offer.servers.map((server) => ({ ...server, tools: [] })),
      };
    },
  }));
  try {
    const offer = tools.offered(1, "", links, "catalog");
    expect(offer.mcp).toHaveLength(2);
    expect(offer.mcpCatalog).toBe("");
    expect(offer.tools.map((tool) => tool.name)).not.toContain("mcp_describe");
    expect(offer.tools.map((tool) => tool.name)).not.toContain("mcp_call");
  } finally {
    await mcp.close();
    db.close();
  }
});

test("all and catalog mode carry the same MCP prompt", async () => {
  const { db, mcp, tools, links } = setup(true);
  try {
    const all = tools.offered(1, "", links, "all");
    const catalog = tools.offered(1, "", links, "catalog");
    expect(catalog.mcpPrompt).toEqual(all.mcpPrompt);
    expect(catalog.mcp).toEqual(all.mcp);
  } finally {
    await mcp.close();
    db.close();
  }
});

test("auto recounts the remaining schemas and moves from catalog to all", async () => {
  const { db, mcp, tools, flux, links } = setup(true);
  try {
    const direct = tools.offered(1, "", links, "all");
    expect(
      wireTokens(direct.tools.filter((tool) => tool.name.startsWith("mcp__"))),
    ).toBeGreaterThan(MCP_CATALOG_FROM_TOKENS);
    const before = tools.offered(1, "", links, "auto");
    expect(before.tools.map((tool) => tool.name)).toContain("mcp_call");
    const after = tools.offered(1, "", links, "auto", undefined, [
      mcpKey(flux.id),
    ]);
    expect(
      wireTokens(after.tools.filter((tool) => tool.name.startsWith("mcp__"))),
    ).toBeLessThanOrEqual(MCP_CATALOG_FROM_TOKENS);
    expect(after.tools.map((tool) => tool.name)).not.toContain("mcp_call");
    expect(after.tools.map((tool) => tool.name)).toContain(
      "mcp__docs__get_item0",
    );
    expect(after.mcpCatalog).toBe("");
    expect(Object.keys(after.mcpPrompt.digest)).toEqual(["docs"]);
  } finally {
    await mcp.close();
    db.close();
  }
});

test("unassigned and missing server keys leave the offer byte-identical", async () => {
  const { db, mcp, tools, links } = setup();
  try {
    const other = seedServer(mcp.store, "other");
    for (const mode of ["all", "catalog", "auto"] as const) {
      const on = tools.offered(1, "", links, mode);
      const off = tools.offered(1, "", links, mode, undefined, [
        mcpKey(other.id),
        mcpKey("missing"),
      ]);
      expect(JSON.stringify(off)).toBe(JSON.stringify(on));
    }
  } finally {
    await mcp.close();
    db.close();
  }
});

test("memory phase offers only memory_edit and never reads MCP or the set", async () => {
  const { db, mcp, tools, flux, links } = setup();
  try {
    const scope = {
      projectId: "project",
      automation: { id: "task", ownMemory: true },
      phase: "memory" as const,
    };
    mcp.offered = () => {
      throw new Error("memory phase read MCP");
    };
    const on = tools.offered(1, "", links, "catalog", scope);
    const off = tools.offered(1, "", links, "catalog", scope, [
      mcpKey(flux.id),
      "web",
    ]);
    expect({ ...off, memory: null }).toEqual({ ...on, memory: null });
    expect(off.memory).toMatchObject({
      work: on.memory!.work,
      stopped: false,
    });
    expect(off.tools.map((tool) => tool.name)).toEqual(["memory_edit"]);
    expect(off.mcp).toEqual([]);
    expect(off.mcpCatalog).toBe("");
    expect(off.mcpPrompt).toEqual({ text: "", digest: {} });
  } finally {
    await mcp.close();
    db.close();
  }
});

test("switchable follows links, sides and patterns without prompt caps", async () => {
  const { db, mcp, flux, docs, links } = setup();
  try {
    expect(mcp.switchable(links)).toEqual([
      { id: docs.id, name: "docs", tools: 1 },
      { id: flux.id, name: "flux", tools: 1 },
    ]);
    const huge = seedServer(mcp.store, "huge");
    db.query("update mcp_tools set input_schema = ? where server_id = ?").run(
      JSON.stringify({ type: "string", enum: ["x".repeat(1024 * 1024)] }),
      huge.id,
    );
    expect(mcp.switchable([link(huge)])).toEqual([
      { id: huge.id, name: "huge", tools: 1 },
    ]);
    expect(mcp.offered([link(huge)]).servers).toEqual([]);
    mcp.store.updateSettings(flux.id, { excludedPatterns: ["*"] });
    expect(mcp.switchable([...links, link({ id: "missing" })])).toEqual([
      { id: docs.id, name: "docs", tools: 1 },
    ]);
    expect(mcp.switchable([{ ...link(docs), read: false }])).toEqual([]);
    mcp.store.updateSettings(docs.id, { read: false });
    expect(mcp.switchable(links)).toEqual([]);
  } finally {
    await mcp.close();
    db.close();
  }
});

// bug: the agents route read every catalog once per agent
test("switchableBy reads the catalogs once for every agent", async () => {
  const { db, mcp, flux, docs, links } = setup();
  try {
    const list = mcp.store.list.bind(mcp.store);
    let reads = 0;
    mcp.store.list = () => {
      reads += 1;
      return list();
    };
    const agents = [
      { id: "a1", servers: links },
      { id: "a2", servers: [link(flux)] },
      { id: "a3", servers: [] },
      { id: "a4", servers: [link({ id: "missing" })] },
    ];
    expect(mcp.switchableBy(agents)).toEqual({
      a1: [
        { id: docs.id, name: "docs", tools: 1 },
        { id: flux.id, name: "flux", tools: 1 },
      ],
      a2: [{ id: flux.id, name: "flux", tools: 1 }],
    });
    expect(reads).toBe(1);
    expect(mcp.switchableBy([{ id: "a3", servers: [] }])).toEqual({});
    expect(reads).toBe(1);
  } finally {
    await mcp.close();
    db.close();
  }
});

test.each(["all", "catalog"] as const)(
  "%s: bash names a tool typed as a command",
  async (mode) => {
    const printed = [
      "bash: mcp_call: command not found",
      "bash: mcp__docs__get_item0: command not found",
      "bash: frobnicate: command not found",
    ].join("\n");
    const { db, tools, links } = setup(false, {
      run: async () => ({
        content: `${printed}\nexit 127`,
        error: true,
        tail: 8,
      }),
    });
    try {
      const offered = tools.offered(1, "", links, mode);
      const result = await tools.run(
        offered,
        {
          id: "typed",
          name: "bash",
          arguments: JSON.stringify({ command: "mcp_call" }),
        },
        {
          ...context(),
          actor: {
            projectId: "project",
            userId: "user",
            agentId: "agent",
            agentName: "coder",
            sessionId: "session",
            origin: "chat",
            sendStartedAt: 0,
          },
        },
      );
      const tool =
        "is one of your tools, not a command: call it as a tool, outside bash.";
      expect(result.content).toBe(
        [
          "bash: mcp_call: command not found",
          ...(mode === "catalog" ? [`mcp_call ${tool}`] : []),
          "bash: mcp__docs__get_item0: command not found",
          mode === "catalog"
            ? "mcp__docs__get_item0 is an MCP tool, not a command: call the mcp_call tool with name mcp__docs__get_item0, outside bash."
            : `mcp__docs__get_item0 ${tool}`,
          "bash: frobnicate: command not found",
          "exit 127",
        ].join("\n"),
      );
    } finally {
      db.close();
    }
  },
);
