// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// MCP servers through compose(): a server added, read, changed,
// refreshed and deleted over the routes, with the fake fetch answering
// the recorded servers on made-up hosts, and the area closed in
// shutdown while a discovery runs.

import { describe, expect, test } from "bun:test";
import type { McpServerSummary } from "../../src/shared/contracts/mcp.ts";
import { fakeFetch, PROVIDER_URL, testApp } from "../helpers/app.ts";
import { fixture, mcpFetch } from "../server/mcp/fake.ts";

// the MCP hosts go to the recorded servers, the rest to the provider
// fake, which fails every other host
async function hosts(
  servers: Record<string, ReturnType<typeof mcpFetch>["fetcher"]>,
): Promise<typeof fetch> {
  const provider = fakeFetch().fetcher;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const server = servers[url.hostname];
    return server ? server(input, init) : provider(input, init);
  }) as typeof fetch;
}

const create = (name = "flux") => ({
  name,
  url: `http://${name}.test/mcp`,
  keyName: null,
  read: true,
  write: false,
  instructionsOn: true,
  timeoutMs: null,
  readPatterns: [
    "get_*",
    "trace_*",
    "diff_*",
    "search_flux_docs",
    "read_flux_doc",
  ],
  writePatterns: [],
  excludedPatterns: ["install_*"],
});

async function setup(
  options: {
    servers?: Record<string, ReturnType<typeof mcpFetch>["fetcher"]>;
    secrets?: Record<string, string>;
  } = {},
) {
  const flux = mcpFetch({ recorded: await fixture("flux") });
  const app = await testApp({
    fetcher: await hosts({ "flux.test": flux.fetcher, ...options.servers }),
    secrets: options.secrets,
  });
  const client = app.client();
  await client.login("admin", "hunter2-test");
  return { app, client, flux };
}

describe("MCP servers over the routes", () => {
  test("a server is added, its tools listed, and the keys named", async () => {
    const { client, flux } = await setup({
      secrets: { "mcp-github": "ghp", openrouter: "sk" },
    });
    const res = await client.call("POST", "/api/mcp", { body: create() });
    expect(res.status).toBe(201);
    const { server } = (await res.json()) as { server: McpServerSummary };
    expect(server.name).toBe("flux");
    expect(server.serverName).toBe("flux-operator-mcp");
    expect(server.protocolVersion).toBe("2026-07-28");
    expect(server.instructions).toContain("Workflow:");
    expect(server.tools).toHaveLength(19);
    expect(server.tools.map((t) => t.name)).toContain("get_flux_instance");
    expect(
      server.tools.every((t) => t.wireName?.startsWith("mcp__flux__")),
    ).toBe(true);
    expect(server.tools.every((t) => t.unusable === null)).toBe(true);
    expect(server.refreshError).toBeNull();
    expect(server.hasKey).toBe(false);
    // the modern era: a probe, then the list, and no handshake
    expect(flux.requests.map((r) => r.method)).toEqual([
      "server/discover",
      "tools/list",
    ]);
    const list = await (await client.call("GET", "/api/mcp")).json();
    expect(list.servers).toEqual([server]);
    // the mcp- key files by name, the provider's left out
    expect(list.keys).toEqual(["mcp-github"]);
    expect(typeof list.loadedAt).toBe("number");
  });

  test("a name taken is 409, a key without the prefix is 400, and a failing host is 502 with no row", async () => {
    const { client } = await setup();
    expect(
      (await client.call("POST", "/api/mcp", { body: create() })).status,
    ).toBe(201);
    const taken = await client.call("POST", "/api/mcp", { body: create() });
    expect(taken.status).toBe(409);
    const key = await client.call("POST", "/api/mcp", {
      body: { ...create("other"), keyName: "github" },
    });
    expect(key.status).toBe(400);
    expect((await key.json()).error).toBe("keyName must start with mcp-");
    const down = await client.call("POST", "/api/mcp", {
      body: { ...create("down"), url: "http://down.test/mcp" },
    });
    expect(down.status).toBe(502);
    const list = await (await client.call("GET", "/api/mcp")).json();
    expect(list.servers.map((s: McpServerSummary) => s.name)).toEqual(["flux"]);
  });

  test("settings change without discovery, an endpoint change discovers first", async () => {
    const docs = mcpFetch({ recorded: await fixture("flux-docs") });
    const { client, flux } = await setup({
      servers: { "docs.test": docs.fetcher },
    });
    const { server } = await (
      await client.call("POST", "/api/mcp", { body: create() })
    ).json();
    const before = flux.requests.length;
    const settings = await client.call("PATCH", `/api/mcp/${server.id}`, {
      body: { write: true, excludedPatterns: [], timeoutMs: 90_000 },
    });
    expect(settings.status).toBe(200);
    const changed = (await settings.json()).server as McpServerSummary;
    expect(changed.write).toBe(true);
    expect(changed.timeoutMs).toBe(90_000);
    expect(changed.excludedPatterns).toEqual([]);
    expect(changed.tools).toHaveLength(19);
    expect(flux.requests.length).toBe(before);
    // a mix of the two is a 400
    const mixed = await client.call("PATCH", `/api/mcp/${server.id}`, {
      body: { url: "http://docs.test/mcp", read: true },
    });
    expect(mixed.status).toBe(400);
    // the endpoint moves to another server: the tools follow, the
    // settings and the id stay
    const moved = await client.call("PATCH", `/api/mcp/${server.id}`, {
      body: { url: "http://docs.test/mcp" },
    });
    expect(moved.status).toBe(200);
    const after = (await moved.json()).server as McpServerSummary;
    expect(after.id).toBe(server.id);
    expect(after.url).toBe("http://docs.test/mcp");
    expect(after.serverName).toBe("flux-operator-docs");
    expect(after.tools).toHaveLength(3);
    expect(after.write).toBe(true);
    expect(after.timeoutMs).toBe(90_000);
    // to a failing host: 502, the row as it was
    const failed = await client.call("PATCH", `/api/mcp/${server.id}`, {
      body: { url: "http://down.test/mcp" },
    });
    expect(failed.status).toBe(502);
    const kept = (await (await client.call("GET", "/api/mcp")).json())
      .servers[0];
    expect(kept.url).toBe("http://docs.test/mcp");
    expect(kept.refreshError).toBeNull();
    expect(kept.tools).toHaveLength(3);
  });

  test("a refresh records what changed, and a failed one keeps the last list", async () => {
    const recorded = await fixture("flux");
    let fail = false;
    let version = "1.0.0";
    const flux = mcpFetch({
      recorded,
      mutateResult: (method, result) => {
        if (fail) throw new Error("boom");
        if (method === "server/discover") {
          return {
            ...result,
            _meta: {
              "io.modelcontextprotocol/serverInfo": {
                name: "flux-operator-mcp",
                version,
              },
            },
          };
        }
        if (method === "tools/list" && version === "2.0.0") {
          const tools = (result.tools as { name: string }[]).filter(
            (t) => t.name !== "get_flux_instance",
          );
          return {
            ...result,
            tools: [
              ...tools,
              {
                name: "get_flux_report",
                description: "New.",
                inputSchema: { type: "object" },
              },
            ],
          };
        }
        return result;
      },
    });
    const { app, client } = await setup({
      servers: { "flux.test": flux.fetcher },
    });
    const { server } = await (
      await client.call("POST", "/api/mcp", { body: create() })
    ).json();
    expect(server.serverVersion).toBe("1.0.0");
    expect(server.lastChange).toBeNull();
    version = "2.0.0";
    app.now.value += 60_000;
    const refreshed = await client.call(
      "POST",
      `/api/mcp/${server.id}/refresh`,
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()).server as McpServerSummary;
    expect(next.serverVersion).toBe("2.0.0");
    expect(next.checkedAt).toBe(app.now.value);
    expect(next.lastChange).toEqual({
      at: app.now.value,
      added: ["get_flux_report"],
      removed: ["get_flux_instance"],
      changed: [],
      instructions: false,
    });
    expect(next.tools.map((t) => t.name)).toContain("get_flux_report");
    fail = true;
    app.now.value += 60_000;
    const broken = await client.call("POST", `/api/mcp/${server.id}/refresh`);
    expect(broken.status).toBe(502);
    const kept = (await (await client.call("GET", "/api/mcp")).json())
      .servers[0] as McpServerSummary;
    expect(kept.refreshError).not.toBeNull();
    expect(kept.refreshFailedAt).toBe(app.now.value);
    expect(kept.checkedAt).toBe(next.checkedAt);
    expect(kept.tools.map((t) => t.name)).toContain("get_flux_report");
  });

  test("delete is 409 while an agent references it and 204 after", async () => {
    const { app, client } = await setup();
    const { server } = await (
      await client.call("POST", "/api/mcp", { body: create() })
    ).json();
    const { provider } = await (
      await client.call("POST", "/api/providers", {
        body: {
          name: "router",
          wire: "openrouter",
          baseUrl: PROVIDER_URL,
          keyName: null,
        },
      })
    ).json();
    const made = await client.call("POST", "/api/agents", {
      body: {
        name: "sre",
        providerId: provider.id,
        model: "deepseek/deepseek-v4.1-flash",
        avatar: "bot",
        thinking: null,
        effort: null,
        prompt: "",
        skills: [],
      },
    });
    expect(made.status).toBe(201);
    const { agent } = await made.json();
    app.mcp.setAgentServers(agent.id, [
      { serverId: server.id, read: true, write: false },
    ]);
    const refused = await client.call("DELETE", `/api/mcp/${server.id}`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("an agent uses the MCP server");
    app.mcp.setAgentServers(agent.id, []);
    expect((await client.call("DELETE", `/api/mcp/${server.id}`)).status).toBe(
      204,
    );
    expect((await client.call("DELETE", `/api/mcp/${server.id}`)).status).toBe(
      404,
    );
    expect(
      (await (await client.call("GET", "/api/mcp")).json()).servers,
    ).toEqual([]);
  });

  test("shutdown aborts a running discovery, writes no failure, and refuses the next", async () => {
    const recorded = await fixture("flux");
    let hang = false;
    const flux = mcpFetch({ recorded });
    const hanging = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (!hang) return flux.fetcher(input, init);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as typeof fetch;
    const { app, client } = await setup({ servers: { "flux.test": hanging } });
    const { server } = await (
      await client.call("POST", "/api/mcp", { body: create() })
    ).json();
    hang = true;
    const pending = client.call("POST", `/api/mcp/${server.id}/refresh`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.shutdown();
    const ended = await pending;
    expect(ended.status).toBe(502);
    const row = app.mcp.byId(server.id);
    expect(row?.refreshError).toBeNull();
    expect(row?.refreshFailedAt).toBeNull();
    const after = await client.call("POST", `/api/mcp/${server.id}/refresh`);
    expect(after.status).toBe(503);
  });
});
