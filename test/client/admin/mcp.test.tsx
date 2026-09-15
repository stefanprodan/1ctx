// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The MCP page's model: the head's words, the change and failure lines,
// the live split and the unmatched marks, the timeout in seconds, the
// key options, the instructions box trimmed to its lines, the agent
// form's preview from the rows loaded; the entity that loads the list
// with the keys and folds a write back; the rail entry; and the page
// and the picker rendered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { railRows } from "../../../src/client/app/routes.ts";
import {
  addServer,
  deleteServer,
  keys,
  loadedAt,
  loadMcp,
  patchServer,
  refreshServer,
  servers,
  serversError,
} from "../../../src/client/data/mcp.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  listedServers,
  sameServers,
  toggleSide,
} from "../../../src/client/views/admin/Agents.model.ts";
import {
  changeLine,
  instructionsBox,
  keyOptions,
  mcpFieldOf,
  metaLine,
  promptPreview,
  timeoutMs,
  timeoutProblem,
  timeoutText,
  toolGroups,
  unmatchedIn,
  unmatchedLine,
} from "../../../src/client/views/admin/Mcp.model.ts";
import { Mcp } from "../../../src/client/views/admin/Mcp.tsx";
import { McpPicker } from "../../../src/client/views/admin/McpPicker.tsx";
import type {
  McpServerSummary,
  McpToolSummary,
} from "../../../src/shared/contracts/mcp.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";
import { MAX_INSTRUCTIONS_BLOCK } from "../../../src/shared/mcp.ts";

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
let answer: (url: string, init?: RequestInit) => Response;

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
  test("the head: the tools and the check, or the failure in red", () => {
    expect(metaLine(flux, now)).toEqual({
      text: "5 tools · checked 2h ago",
      bad: false,
    });
    expect(
      metaLine(
        server({ refreshError: "boom", refreshFailedAt: now - 60_000 }),
        now,
      ),
    ).toEqual({ text: "refresh failed 1m ago", bad: true });
  });

  test("the last change as one line", () => {
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

  test("the four groups from the fields, live", () => {
    const groups = toolGroups(flux, {
      read: ["get_*"],
      write: [],
      excluded: ["install_*"],
    });
    expect(groups.read.map((t) => t.name)).toEqual(["get_flux_instance"]);
    expect(groups.write.map((t) => t.name)).toEqual([
      "trace_kubernetes_resource",
      "reconcile_flux_resource",
    ]);
    expect(groups.excluded.map((t) => t.name)).toEqual([
      "install_flux_instance",
    ]);
    expect(groups.unusable).toEqual([
      { tool: flux.tools[4]!, reason: "unusable name" },
    ]);
    expect(unmatchedIn(flux, ["get_*", "search_flux_doc"])).toEqual([
      "search_flux_doc",
    ]);
    expect(unmatchedLine([])).toBe("");
    expect(unmatchedLine(["x"])).toBe("matches no tool: x");
    expect(unmatchedLine(["x", "y*"])).toBe("match no tool: x, y*");
  });

  test("the timeout in seconds, empty for the limits' value", () => {
    expect(timeoutText(null)).toBe("");
    expect(timeoutText(90_000)).toBe("90");
    expect(timeoutMs("")).toBeNull();
    expect(timeoutMs(" 2.5 ")).toBe(2500);
    expect(timeoutProblem("")).toBeNull();
    expect(timeoutProblem("90")).toBeNull();
    expect(timeoutProblem("abc")).toBe("A number of seconds");
    expect(timeoutProblem("0.5")).toBe("1 to 3600 seconds");
    expect(timeoutProblem("3601")).toBe("1 to 3600 seconds");
  });

  test("the key options: No key first, the files, a missing one marked", () => {
    expect(keyOptions(["mcp-github"], null)).toEqual([
      { value: "", label: "No key" },
      { value: "mcp-github", label: "mcp-github" },
    ]);
    expect(keyOptions(["mcp-github"], "mcp-flux")).toEqual([
      { value: "", label: "No key" },
      { value: "mcp-github", label: "mcp-github" },
      { value: "mcp-flux", label: "mcp-flux", detail: "missing" },
    ]);
  });

  test("the instructions box shows the block, trimmed past 12 lines", () => {
    const short = instructionsBox("flux", "one\ntwo", false);
    expect(short.text).toBe(
      '  <server name="flux">\n    one\n    two\n  </server>',
    );
    expect(short.canToggle).toBe(false);
    expect(short.count).toBe(short.text.length);
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const folded = instructionsBox("flux", long, false);
    expect(folded.canToggle).toBe(true);
    expect(folded.text.split("\n")).toHaveLength(12);
    expect(instructionsBox("flux", long, true).text.split("\n")).toHaveLength(
      22,
    );
  });

  test("the agent form's preview from the rows loaded", () => {
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
    // the switch off on the only server: no line, no warning
    const quiet = promptPreview(
      [server({ instructionsOn: false })],
      [links[0]!],
    );
    expect(quiet).toEqual({ line: "", warnings: [], text: "" });
    // write alone on the agent while the server has it off: nothing offered
    expect(
      promptPreview([flux], [{ serverId: "m1", read: false, write: true }])
        .line,
    ).toBe("");
  });

  test("a refusal's field", () => {
    expect(mcpFieldOf("name is invalid")).toBe("name");
    expect(mcpFieldOf("an MCP server named flux exists")).toBe("name");
    expect(mcpFieldOf("keyName must start with mcp-")).toBe("keyName");
    expect(mcpFieldOf("readPatterns has an invalid pattern")).toBe(
      "readPatterns",
    );
    expect(mcpFieldOf("the server refused the key")).toBeUndefined();
  });

  test("the agent's servers: a side toggled, the listed ones, the same set", () => {
    const one = toggleSide([], "m1", "read");
    expect(one).toEqual([{ serverId: "m1", read: true, write: false }]);
    const both = toggleSide(one, "m1", "write");
    expect(both).toEqual([{ serverId: "m1", read: true, write: true }]);
    expect(toggleSide(toggleSide(both, "m1", "read"), "m1", "write")).toEqual(
      [],
    );
    expect(listedServers(both, null)).toBe(both);
    expect(listedServers(both, [{ id: "m2" }])).toEqual([]);
    expect(
      sameServers(both, [{ serverId: "m1", write: true, read: true }]),
    ).toBe(true);
    expect(sameServers(both, one)).toBe(false);
  });
});

describe("the entity", () => {
  test("loads the rows with the keys and when they were read, and folds a write back", async () => {
    const calls: string[] = [];
    answer = (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/mcp" && (init?.method ?? "GET") === "GET") {
        return Response.json({
          servers: [flux],
          keys: ["mcp-github"],
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
  });

  test("a load that fails is the page's error", async () => {
    answer = () => Response.json({ error: "down" }, { status: 503 });
    await loadMcp();
    expect(servers.value).toBeNull();
    expect(serversError.value).toEqual({ words: "down", status: 503 });
  });
});

describe("the page", () => {
  test("sits in the Admin group after Skills", () => {
    const group = railRows("admin").find((r) => r.kind === "group");
    const labels =
      group?.kind === "group" ? group.routes.map((r) => r.nav!.label) : [];
    expect(labels.at(-1)).toBe("MCP");
    expect(labels.at(-2)).toBe("Skills");
  });

  test("renders the rows with their head and the loaded-ago hint", () => {
    servers.value = [flux];
    loadedAt.value = Date.now() - 2 * 60_000;
    const html = render(<Mcp />);
    expect(html).toContain("flux");
    expect(html).toContain("5 tools · checked");
    expect(html).toContain("loaded 2m ago");
    expect(html).toContain("New server");
  });

  test("the picker shows a side off on the server faint, and the preview", () => {
    const html = render(
      <McpPicker
        available={[flux]}
        loadedAt={Date.now() - 60_000}
        chosen={[{ serverId: "m1", read: true, write: false }]}
        mode="auto"
        takesTools
        busy={false}
        onToggle={() => {}}
        onMode={() => {}}
      />,
    );
    expect(html).toContain("off on the server");
    expect(html).toContain("as of the servers loaded 1m ago");
    expect(html).toContain("Instructions in the prompt:");
    expect(html).toContain("Every tool schema goes to the model");
    const none = render(
      <McpPicker
        available={[]}
        loadedAt={null}
        chosen={[]}
        mode="auto"
        takesTools={false}
        busy={false}
        onToggle={() => {}}
        onMode={() => {}}
      />,
    );
    expect(none).toContain("No MCP servers yet");
  });
});
