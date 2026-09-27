// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The MCP pages' model: the change line, the timeout in seconds, the
// instructions box trimmed to its lines, the agent form's preview from
// the rows loaded; the entity that loads the list with the keys and
// folds a write back; and the list and a server's tabs rendered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import { agents } from "../../../src/client/data/agents.ts";
import {
  addServer,
  callTimeoutMs,
  deleteServer,
  keys,
  loadedAt,
  loadMcp,
  patchServer,
  refreshServer,
  servers,
  serversError,
  serverUsage,
} from "../../../src/client/data/mcp.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  listed,
  sameServers,
} from "../../../src/client/views/admin/Agents.model.ts";
import {
  changeLine,
  instructionsBox,
  mcpFieldOf,
  promptPreview,
  timeoutMs,
  timeoutProblem,
  timeoutText,
} from "../../../src/client/views/admin/Mcp.model.ts";
import {
  McpList,
  sidesLine,
} from "../../../src/client/views/admin/McpList.tsx";
import { McpPage, mcpTabOf } from "../../../src/client/views/admin/McpPage.tsx";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type {
  McpServerSummary,
  McpToolSummary,
} from "../../../src/shared/contracts/mcp.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";
import {
  MAX_INSTRUCTIONS_BLOCK,
  MAX_SCHEMAS_BYTES,
} from "../../../src/shared/mcp.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
};

const HOUR = 3_600_000;
const now = 1_789_000_000_000;

const tool = (
  name: string,
  description = `${name} does things.`,
): McpToolSummary => ({
  name,
  wireName: `mcp__flux__${name}`,
  unusable: null,
  description,
  parameters: { type: "object", properties: {} },
  schemaJson: '{"type":"object","properties":{}}',
  parametersHtml: "<pre>{}</pre>",
});

const server = (changes: Partial<McpServerSummary> = {}): McpServerSummary => ({
  id: "m1",
  name: "flux",
  url: "http://flux.test/mcp",
  keyName: null,
  hasKey: false,
  read: true,
  write: false,
  instructionsOn: true,
  timeoutMs: null,
  readPatterns: ["get_*", "trace_*"],
  writePatterns: [],
  excludedPatterns: ["install_*"],
  serverName: "flux-operator-mcp",
  serverVersion: "1.0.0",
  protocolVersion: "2026-07-28",
  instructions: "Workflow:\n- call get_flux_instance first.",
  checkedAt: now - 2 * HOUR,
  lastChange: null,
  refreshError: null,
  refreshFailedAt: null,
  createdAt: now - 3 * HOUR,
  tools: [
    tool("get_flux_instance"),
    tool("trace_kubernetes_resource"),
    tool("reconcile_flux_resource"),
    tool("install_flux_instance"),
    { ...tool("a.b"), wireName: null },
  ],
  ...changes,
});
const flux = server();

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  me.value = admin;
  servers.value = null;
  serversError.value = null;
  keys.value = [];
  loadedAt.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the model", () => {
  test.serial("the last change as one line", () => {
    expect(changeLine(null, now)).toBe("");
    expect(
      changeLine(
        {
          at: now - 2 * HOUR,
          added: ["a"],
          removed: ["b"],
          changed: ["c", "d"],
          instructions: true,
        },
        now,
      ),
    ).toBe("2h ago: 1 tool added, 1 removed, 2 changed, instructions changed");
    expect(
      changeLine(
        {
          at: now,
          added: [],
          removed: [],
          changed: ["c"],
          instructions: false,
        },
        now,
      ),
    ).toBe("0s ago: 1 tool changed");
  });

  test.serial("the timeout in seconds, empty for the limits' value", () => {
    expect(timeoutText(null)).toBe("");
    expect(timeoutText(90_000)).toBe("90");
    expect(timeoutMs("")).toBeNull();
    expect(timeoutMs(" 2.5 ")).toBe(2500);
    expect(timeoutProblem("")).toBeNull();
    expect(timeoutProblem("90")).toBeNull();
    expect(timeoutProblem("abc")).toBe(
      "The call timeout needs a number of seconds",
    );
    expect(timeoutProblem("0.5")).toBe(
      "The call timeout must be from 1 to 3600 seconds",
    );
    expect(timeoutProblem("3601")).toBe(
      "The call timeout must be from 1 to 3600 seconds",
    );
  });

  test.serial(
    "the instructions box shows the block, trimmed past 12 lines",
    () => {
      const short = instructionsBox("flux", "one\ntwo", false);
      expect(short.text).toBe(
        '  <server name="flux">\n    one\n    two\n  </server>',
      );
      expect(short.cut).toBe(false);
      expect(short.count).toBe(short.text.length);
      const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
      const folded = instructionsBox("flux", long, false);
      expect(folded.cut).toBe(true);
      expect(folded.text.split("\n")).toHaveLength(12);
      expect(instructionsBox("flux", long, true).text.split("\n")).toHaveLength(
        22,
      );
    },
  );

  test.serial("the agent form's preview from the rows loaded", () => {
    const docs = server({
      id: "m2",
      name: "docs",
      write: true,
      instructions: "x".repeat(MAX_INSTRUCTIONS_BLOCK),
      readPatterns: [],
    });
    const links = [
      { serverId: "m1", read: true, write: true },
      { serverId: "m2", read: true, write: true },
    ];
    const preview = promptPreview([flux, docs], links);
    expect(preview.line).toMatch(
      /^Instructions in the prompt: [\d,]+ of 32,000 characters, from flux$/,
    );
    expect(preview.warnings).toEqual(["docs left out: over the 32,000 cap"]);
    expect(preview.text).toContain('<server name="flux">');
    expect(preview.text).not.toContain('name="docs"');
    const huge = server({
      id: "m3",
      name: "huge",
      instructions: "huge instructions",
      tools: [
        {
          ...tool("get_huge"),
          wireName: "mcp__huge__get_huge",
          schemaJson: JSON.stringify({
            type: "object",
            enum: ["x".repeat(MAX_SCHEMAS_BYTES)],
          }),
        },
      ],
    });
    const schemaPreview = promptPreview(
      [flux, huge],
      [links[0]!, { serverId: "m3", read: true, write: true }],
    );
    expect(schemaPreview.warnings).toEqual([
      "huge left out: its tools are over the 1 MB cap",
    ]);
    expect(schemaPreview.line).toEndWith("from flux");
    // the switch off on the only server: no line, no warning
    const quiet = promptPreview(
      [server({ instructionsOn: false })],
      [links[0]!],
    );
    expect(quiet).toEqual({
      line: "",
      warnings: [],
      text: "",
      count: 0,
      from: [],
    });
    // write alone on the agent while the server has it off: nothing offered
    expect(
      promptPreview([flux], [{ serverId: "m1", read: false, write: true }])
        .line,
    ).toBe("");
  });

  test.serial("a refusal's field", () => {
    expect(mcpFieldOf("name is invalid")).toBe("name");
    expect(mcpFieldOf("an MCP server named flux exists")).toBe("name");
    expect(mcpFieldOf("keyName must start with mcp-")).toBe("keyName");
    expect(mcpFieldOf("readPatterns has an invalid pattern")).toBe(
      "readPatterns",
    );
    expect(mcpFieldOf("the MCP server refused the key")).toBe("keyName");
    expect(mcpFieldOf("the MCP server is offline")).toBe("url");
    expect(mcpFieldOf("MCP request timed out")).toBe("url");
    expect(mcpFieldOf("an agent uses the MCP server")).toBeUndefined();
    expect(mcpFieldOf("the MCP server is refreshing")).toBeUndefined();
  });

  test.serial("the agent's servers: the listed ones, the same set", () => {
    const one = [{ serverId: "m1", read: true, write: false }];
    const both = [{ serverId: "m1", read: true, write: true }];
    expect(listed(both, (s) => s.serverId, null)).toBe(both);
    expect(listed(both, (s) => s.serverId, [{ id: "m2" }])).toEqual([]);
    expect(listed(["s1", "s2"], (id) => id, [{ id: "s2" }])).toEqual(["s2"]);
    expect(
      sameServers(both, [{ serverId: "m1", write: true, read: true }]),
    ).toBe(true);
    expect(sameServers(both, one)).toBe(false);
  });
});

describe("the entity", () => {
  test.serial(
    "loads the rows with the keys and when they were read, and folds a write back",
    async () => {
      const calls: string[] = [];
      answer = (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/mcp" && (init?.method ?? "GET") === "GET") {
          return Response.json({
            servers: [flux],
            keys: ["mcp-github"],
            callTimeoutMs: 20_000,
            loadedAt: now,
          });
        }
        if (url === "/api/mcp/m1" && init?.method === "PATCH") {
          return Response.json({ server: server({ write: true }) });
        }
        if (url === "/api/mcp/m1/refresh") {
          return Response.json({
            server: server({ serverVersion: "2.0.0", checkedAt: now }),
          });
        }
        if (url === "/api/mcp" && init?.method === "POST") {
          return Response.json({ server: server({ id: "m2", name: "docs" }) });
        }
        if (url === "/api/mcp/m2" && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "nope" }, { status: 500 });
      };
      await loadMcp();
      expect(servers.value).toEqual([flux]);
      expect(keys.value).toEqual(["mcp-github"]);
      expect(callTimeoutMs.value).toBe(20_000);
      expect(loadedAt.value).toBe(now);
      await patchServer("m1", { write: true });
      expect(servers.value?.[0]?.write).toBe(true);
      await refreshServer("m1");
      expect(servers.value?.[0]?.serverVersion).toBe("2.0.0");
      await addServer({
        name: "docs",
        url: "http://docs.test/mcp",
        keyName: null,
        read: true,
        write: false,
        instructionsOn: true,
        timeoutMs: null,
        readPatterns: [],
        writePatterns: [],
        excludedPatterns: [],
      });
      expect(servers.value?.map((s) => s.name)).toEqual(["docs", "flux"]);
      await deleteServer("m2");
      expect(servers.value?.map((s) => s.name)).toEqual(["flux"]);
      expect(calls[0]).toBe("GET /api/mcp");
    },
  );

  test.serial("a write supersedes a load in flight", async () => {
    let finishLoad!: (response: Response) => void;
    let finishWrite!: (response: Response) => void;
    const loadResponse = new Promise<Response>((resolve) => {
      finishLoad = resolve;
    });
    const writeResponse = new Promise<Response>((resolve) => {
      finishWrite = resolve;
    });
    answer = (_url, init) =>
      init?.method === "PATCH" ? writeResponse : loadResponse;
    const loading = loadMcp();
    const writing = patchServer("m1", { write: true });
    finishLoad(
      Response.json({
        servers: [flux],
        keys: [],
        callTimeoutMs: 20_000,
        loadedAt: now - HOUR,
      }),
    );
    await loading;
    expect(servers.value).toBeNull();
    finishWrite(Response.json({ server: server({ write: true }) }));
    await writing;
    expect(servers.value?.[0]?.write).toBe(true);
  });

  test.serial("a load that fails is the page's error", async () => {
    answer = () => Response.json({ error: "down" }, { status: 503 });
    await loadMcp();
    expect(servers.value).toBeNull();
    expect(serversError.value).toEqual({ words: "down", status: 503 });
  });
});

const agent = (name: string, write: boolean) =>
  ({
    id: `a-${name}`,
    name,
    avatar: "bot",
    servers: [{ serverId: "m1", read: true, write }],
  }) as unknown as AgentSummary;

describe("the list", () => {
  test.serial("a row per server: the URL, its agents and its sides", () => {
    servers.value = [flux];
    keys.value = ["mcp-github"];
    agents.value = [agent("sre", false)];
    const html = render(<McpList />);
    expect(html).toContain('href="/config/mcp/flux"');
    expect(html).toContain(flux.url);
    expect(html).toContain("1 agent");
    expect(html).toContain("2 read · write off");
    expect(html).toContain('href="/config/mcp?new"');
    expect(html).toContain("mcp-github.key");
    expect(html).toContain("unused");
  });

  test.serial("the sides: a count per side on, off for the other", () => {
    // reconcile_flux_resource is written by default, install_ excluded
    expect(sidesLine(server({ write: true }))).toBe("2 read · 1 write");
    expect(sidesLine(server({ read: false }))).toBe("read off · write off");
  });

  test.serial("a failed refresh takes the URL's place, in red", () => {
    servers.value = [
      server({ refreshError: "offline", refreshFailedAt: Date.now() - 60_000 }),
    ];
    agents.value = [];
    const html = render(<McpList />);
    expect(html).toContain("refresh failed 1m ago");
    expect(html).toContain("No agents");
  });
});

describe("a server's page", () => {
  test.serial("the tab is the step after the name", () => {
    expect(mcpTabOf("/config/mcp/flux")).toBe("general");
    expect(mcpTabOf("/config/mcp/flux/tools")).toBe("tools");
    expect(mcpTabOf("/config/mcp/tools")).toBe("general");
  });

  test.serial("General: the facts, the endpoint, the agents on it", () => {
    servers.value = [flux];
    agents.value = [agent("sre", true)];
    path.value = "/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toContain("flux-operator-mcp 1.0.0");
    expect(html).toContain("2026-07-28");
    expect(html).toContain(`value="${flux.url}"`);
    expect(html).toContain('href="/config/agents/sre/mcp"');
    expect(html).toContain("Read and write");
    expect(html).toContain("1 agent uses it. Remove it from that agent first.");
    // the server refuses a server an agent uses, so Delete waits
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete</);
    expect(html).toContain("Put them in the system prompt");
  });

  test.serial("waits for the agents, so Delete never opens early", () => {
    servers.value = [flux];
    agents.value = null;
    path.value = "/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toContain("Loading");
    expect(html).not.toContain("Delete flux");
  });

  test.serial("General: a failed refresh over the tabs, no agents", () => {
    servers.value = [
      server({
        instructions: "",
        refreshError: "discovery failed",
        refreshFailedAt: Date.now() - 60_000,
        checkedAt: Date.now() - 2 * HOUR,
      }),
    ];
    agents.value = [];
    path.value = "/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toContain(
      "Refresh failed 1m ago: Discovery failed. Agents are still offered the 5 tools listed 2h ago, and their calls fail until the server answers.",
    );
    expect(html).toContain("The server sent no instructions.");
    expect(html).toContain("No agent uses it.");
    expect(html).not.toContain("Used by");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Delete</);
  });

  test.serial("General: long instructions fold with Show all", () => {
    servers.value = [
      server({
        instructions: Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
          "\n",
        ),
      }),
    ];
    agents.value = [];
    path.value = "/config/mcp/flux";
    const html = render(<McpPage params={{ name: "flux" }} />);
    expect(html).toMatch(/fold-more">[^<]*<button[^>]*>Show all \d+ lines</);
  });

  test.serial(
    "Tools: the matchers with what they decide, each tool's side",
    () => {
      servers.value = [server({ readPatterns: ["get_*", "trace_*", "gte_*"] })];
      agents.value = [];
      path.value = "/config/mcp/flux/tools";
      const html = render(<McpPage params={{ name: "flux" }} />);
      // get_* decides one tool, a typo matches none and is marked
      expect(html).toMatch(
        /get_\*<\/span><span class="mcp-page-chip-count">1</,
      );
      expect(html).toContain("mcp-page-chip-none");
      expect(html).toContain("gte_* matches no tool");
      expect(html).toContain("by get_*");
      expect(html).toContain("by default");
      expect(html).toContain("by install_*");
      // a name too long for the wire cannot be picked
      expect(html).toContain("Unusable 1");
      expect(html).toContain("Pick every tool shown");
    },
  );

  test.serial(
    "the aside has its last 30 days and its most called tools",
    () => {
      servers.value = [flux];
      agents.value = [];
      path.value = "/config/mcp/flux";
      serverUsage.value = null;
      const page = () => render(<McpPage params={{ name: "flux" }} />);
      expect(page()).toContain("Loading");
      serverUsage.value = {
        serverId: "m1",
        usage: {
          since: 0,
          until: 1,
          calls: 12,
          failed: 2,
          tools: [{ name: "get_flux_instance", calls: 10 }],
        },
      };
      expect(page()).toMatch(/Calls[\s\S]*?12/);
      expect(page()).toMatch(/get_flux_instance[\s\S]*?10/);
      serverUsage.value = { serverId: "m1", usage: null };
      expect(page()).toContain("Did not load.");
    },
  );
});
