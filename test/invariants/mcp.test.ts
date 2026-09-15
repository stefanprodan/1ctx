// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// MCP servers through compose(): a server added, read, changed,
// refreshed and deleted over the routes, with the fake fetch answering
// the recorded servers on made-up hosts, and the area closed in
// shutdown while a discovery runs.

import { describe, expect, test } from "bun:test";
import { sha256 } from "../../src/server/lib/ids.ts";
import { tokens } from "../../src/server/lib/tokens.ts";
import type { McpServerSummary } from "../../src/shared/contracts/mcp.ts";
import { offeredServers, promptSnapshot } from "../../src/shared/mcp.ts";
import { fakeFetch, PROVIDER_URL, testApp } from "../helpers/app.ts";
import { chatApp, startChat, tick, waitScript } from "../helpers/chat.ts";
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
        servers: [],
        mcpMode: "auto",
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

const toolNames = (body: Record<string, unknown>): string[] =>
  (body.tools as { function: { name: string } }[] | undefined)?.map(
    (tool) => tool.function.name,
  ) ?? [];

async function waitDone(
  app: Awaited<ReturnType<typeof chatApp>>["app"],
  id: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (app.sessions.byId(id)?.status !== "running") return;
    await tick();
  }
  throw new Error("chat did not finish");
}

async function saveServers(
  chat: Awaited<ReturnType<typeof chatApp>>,
  servers: { serverId: string; read: boolean; write: boolean }[],
  mcpMode: "all" | "catalog" | "auto",
) {
  const agent = chat.app.agents.byId(chat.agentId)!;
  const saved = await chat.admin.call("PATCH", `/api/agents/${agent.id}`, {
    body: {
      name: agent.name,
      avatar: agent.avatar,
      providerId: agent.providerId,
      model: agent.model.id,
      thinking: agent.thinking,
      effort: agent.effort,
      prompt: agent.prompt,
      skills: agent.skills,
      servers,
      mcpMode,
    },
  });
  expect(saved.status).toBe(200);
}

async function sendFixture(options: {
  callResult?: Record<string, unknown>;
  mode?: "all" | "catalog" | "auto";
  timeoutMs?: number | null;
  wrap?: (fetcher: typeof fetch) => typeof fetch;
}) {
  const flux = mcpFetch({
    recorded: await fixture("flux"),
    callResult: options.callResult,
  });
  const chat = await chatApp({
    fetcher: options.wrap?.(flux.fetcher) ?? flux.fetcher,
  });
  const { server } = await (
    await chat.admin.call("POST", "/api/mcp", {
      body: {
        ...create(),
        timeoutMs: options.timeoutMs ?? null,
      },
    })
  ).json();
  const servers = [{ serverId: server.id, read: true, write: false }];
  await saveServers(chat, servers, options.mode ?? "auto");
  return { chat, flux, server, servers };
}

describe("MCP tools in a send", () => {
  test("offers the shared read snapshot and calls it as a tool row", async () => {
    const { chat, flux, server, servers } = await sendFixture({});
    const started = await startChat(chat, "inspect flux");
    const names = toolNames(started.script.body);
    expect(names).toContain("mcp__flux__get_flux_instance");
    expect(names).not.toContain("mcp__flux__reconcile_flux_kustomization");

    const list = await (await chat.admin.call("GET", "/api/mcp")).json();
    const prompt = promptSnapshot(
      offeredServers(list.servers, servers),
      sha256,
    ).text;
    const messages = started.script.body.messages as {
      role: string;
      content: string;
    }[];
    expect(messages[0]?.content).toContain(prompt);
    const directory = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(directory.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "datetime",
      "webfetch",
    ]);
    expect(directory.tokens.tools).toBe(
      tokens(JSON.stringify(started.script.body.tools ?? [])),
    );

    started.script.toolRound([
      {
        id: "mcp-1",
        name: "mcp__flux__get_flux_instance",
        arguments: "{}",
      },
    ]);
    started.script.end();
    const answer = await waitScript(chat.scripted, 2);
    answer.reply("done");
    await waitDone(chat.app, started.sessionId);
    const tool = chat.app.sessions
      .messages(started.sessionId)
      .find((row) => row.kind === "tool");
    expect(tool).toMatchObject({
      toolName: "mcp__flux__get_flux_instance",
      status: "done",
      content: "called",
    });
    expect(
      flux.requests.filter((request) => request.method === "tools/call"),
    ).toHaveLength(1);

    const agent = chat.app.agents.byId(chat.agentId)!;
    await chat.admin.call("PATCH", `/api/agents/${agent.id}`, {
      body: {
        name: agent.name,
        avatar: agent.avatar,
        providerId: agent.providerId,
        model: agent.model.id,
        thinking: agent.thinking,
        effort: agent.effort,
        prompt: agent.prompt,
        skills: agent.skills,
        servers: [{ serverId: server.id, read: false, write: true }],
        mcpMode: "all",
      },
    });
    const none = await startChat(chat, "write flux");
    expect(
      toolNames(none.script.body).some((name) => name.startsWith("mcp__")),
    ).toBe(false);
    none.script.reply("none");
    await waitDone(chat.app, none.sessionId);
  });

  test("records an MCP isError answer as a failed tool row", async () => {
    const { chat } = await sendFixture({
      callResult: {
        content: [{ type: "text", text: "flux refused the call" }],
        isError: true,
      },
    });
    const started = await startChat(chat);
    started.script.toolRound([
      {
        id: "mcp-error",
        name: "mcp__flux__get_flux_instance",
        arguments: "{}",
      },
    ]);
    started.script.end();
    const answer = await waitScript(chat.scripted, 2);
    const row = chat.app.sessions
      .messages(started.sessionId)
      .find((message) => message.kind === "tool");
    expect(row).toMatchObject({
      toolName: "mcp__flux__get_flux_instance",
      status: "failed",
    });
    expect(row?.content).toContain("flux refused the call");
    answer.reply("handled");
    await waitDone(chat.app, started.sessionId);
  });

  test("catalog mode describes and validates calls without changing its tools", async () => {
    const { chat, flux } = await sendFixture({ mode: "catalog" });
    const started = await startChat(chat);
    expect(toolNames(started.script.body)).toContain("mcp_describe");
    expect(toolNames(started.script.body)).toContain("mcp_call");
    expect(toolNames(started.script.body)).not.toContain(
      "mcp__flux__get_flux_instance",
    );
    const directory = await (
      await chat.member.call("GET", "/api/directory/agents/coder")
    ).json();
    expect(directory.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "datetime",
      "webfetch",
    ]);
    expect(directory.tokens.tools).toBe(
      tokens(JSON.stringify(started.script.body.tools ?? [])),
    );

    started.script.toolRound([
      {
        id: "describe",
        name: "mcp_describe",
        arguments: JSON.stringify({ name: "mcp__flux__search_flux_docs" }),
      },
    ]);
    started.script.end();
    const bad = await waitScript(chat.scripted, 2);
    bad.toolRound([
      {
        id: "bad",
        name: "mcp_call",
        arguments: JSON.stringify({
          name: "mcp__flux__search_flux_docs",
          arguments: {},
        }),
      },
    ]);
    bad.end();
    const extra = await waitScript(chat.scripted, 3);
    expect(
      flux.requests.filter((request) => request.method === "tools/call"),
    ).toHaveLength(0);
    extra.toolRound([
      {
        id: "extra",
        name: "mcp_call",
        arguments: JSON.stringify({
          name: "mcp__flux__search_flux_docs",
          arguments: { query: "HelmRelease", extra: true },
        }),
      },
    ]);
    extra.end();
    const good = await waitScript(chat.scripted, 4);
    expect(
      flux.requests.filter((request) => request.method === "tools/call"),
    ).toHaveLength(0);
    good.toolRound([
      {
        id: "good",
        name: "mcp_call",
        arguments: JSON.stringify({
          name: "mcp__flux__search_flux_docs",
          arguments: { query: "HelmRelease valuesFrom" },
        }),
      },
    ]);
    good.end();
    const answer = await waitScript(chat.scripted, 5);
    expect(
      flux.requests.filter((request) => request.method === "tools/call"),
    ).toHaveLength(1);
    expect(chat.scripted.scripts.map((script) => script.body.tools)).toEqual([
      started.script.body.tools,
      started.script.body.tools,
      started.script.body.tools,
      started.script.body.tools,
      started.script.body.tools,
    ]);
    const rows = chat.app.sessions
      .messages(started.sessionId)
      .filter((message) => message.kind === "tool");
    expect(rows[0]?.content).toContain('"required": [');
    expect(rows[0]?.content).not.toContain("additionalProperties");
    expect(rows[1]).toMatchObject({
      toolName: "mcp__flux__search_flux_docs",
      status: "failed",
    });
    expect(rows[1]?.content).toContain("required property 'query'");
    expect(rows[2]).toMatchObject({
      toolName: "mcp__flux__search_flux_docs",
      status: "failed",
    });
    expect(rows[2]?.content).toContain("additional properties");
    expect(rows[3]).toMatchObject({
      toolName: "mcp__flux__search_flux_docs",
      status: "done",
    });
    answer.reply("done");
    await waitDone(chat.app, started.sessionId);
  });

  test("auto keeps three Flux catalogs direct and flips when GitHub is added", async () => {
    const transports = {
      flux: mcpFetch({ recorded: await fixture("flux") }),
      docs: mcpFetch({ recorded: await fixture("flux-docs") }),
      schema: mcpFetch({ recorded: await fixture("flux-schema") }),
      github: mcpFetch({ recorded: await fixture("github") }),
    };
    const fallback = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const transport =
        transports[url.hostname.split(".")[0] as keyof typeof transports];
      if (transport === undefined) throw new TypeError("unable to connect");
      return transport.fetcher(input, init);
    }) as typeof fetch;
    const chat = await chatApp({ fetcher: fallback });
    const links: { serverId: string; read: boolean; write: boolean }[] = [];
    for (const name of ["flux", "docs", "schema", "github"] as const) {
      const response = await chat.admin.call("POST", "/api/mcp", {
        body: {
          ...create(name),
          readPatterns: ["*"],
          excludedPatterns: [],
        },
      });
      expect(response.status).toBe(201);
      const { server } = await response.json();
      links.push({ serverId: server.id, read: true, write: false });
    }
    await saveServers(chat, links.slice(0, 3), "auto");
    const first = await startChat(chat);
    expect(
      toolNames(first.script.body).filter((name) => name.startsWith("mcp__")),
    ).toHaveLength(27);
    expect(toolNames(first.script.body)).not.toContain("mcp_call");

    await saveServers(chat, links, "auto");
    expect(toolNames(first.script.body)).not.toContain("mcp_call");
    first.script.reply("first");
    await waitDone(chat.app, first.sessionId);

    const secondPending = chat.scripted.next();
    const secondResponse = await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      { body: { message: "again" } },
    );
    expect(secondResponse.status).toBe(201);
    const second = await secondPending;
    expect(toolNames(second.body)).toContain("mcp_describe");
    expect(toolNames(second.body)).toContain("mcp_call");
    expect(
      toolNames(second.body).some((name) => name.startsWith("mcp__")),
    ).toBe(false);
    const system = (
      second.body.messages as { role: string; content: string }[]
    )[0]!.content;
    expect(system).toContain("<available_mcp_tools>");
    expect(system.indexOf("<available_mcp_tools>")).toBeLessThan(
      system.indexOf("<mcp_instructions>"),
    );
    expect(system.indexOf("Today is ")).toBeLessThan(
      system.indexOf("Since your last turn"),
    );
    expect(system).toContain("- github: now available");
    second.reply("second");
    await waitDone(chat.app, first.sessionId);

    const thirdPending = chat.scripted.next();
    await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      {
        body: { message: "once more" },
      },
    );
    const third = await thirdPending;
    const thirdSystem = (
      third.body.messages as { role: string; content: string }[]
    )[0]!.content;
    expect(thirdSystem).not.toContain("Since your last turn");
    third.reply("third");
    await waitDone(chat.app, first.sessionId);
  });

  test("uses the server timeout while a built-in in the round finishes", async () => {
    const wrap = (fetcher: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(String(input), init);
        if (request.method === "POST") {
          const body = (await request.clone().json()) as { method?: string };
          if (body.method === "tools/call") {
            return new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => reject(request.signal.reason),
                { once: true },
              );
            });
          }
        }
        return fetcher(input, init);
      }) as typeof fetch;
    const { chat } = await sendFixture({ timeoutMs: 1000, wrap });
    const started = await startChat(chat);
    started.script.toolRound([
      {
        id: "slow",
        name: "mcp__flux__get_flux_instance",
        arguments: "{}",
      },
      {
        id: "time",
        name: "datetime",
        arguments: JSON.stringify({ timezone: "UTC" }),
      },
    ]);
    started.script.end();
    const answer = await waitScript(chat.scripted, 2, 400);
    const rows = chat.app.sessions
      .messages(started.sessionId)
      .filter((message) => message.kind === "tool");
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[0]?.content).toContain("timed out after 1 seconds");
    expect(rows[1]).toMatchObject({ status: "done", toolName: "datetime" });
    answer.reply("done");
    await waitDone(chat.app, started.sessionId);
  });

  test("a stop aborts an MCP call without waiting for its timeout", async () => {
    let reached!: () => void;
    const called = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const wrap = (fetcher: typeof fetch) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(String(input), init);
        if (request.method === "POST") {
          const body = (await request.clone().json()) as { method?: string };
          if (body.method === "tools/call") {
            reached();
            return new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => reject(request.signal.reason),
                { once: true },
              );
            });
          }
        }
        return fetcher(input, init);
      }) as typeof fetch;
    const { chat } = await sendFixture({ timeoutMs: 60_000, wrap });
    const started = await startChat(chat);
    started.script.toolRound([
      {
        id: "stopped",
        name: "mcp__flux__get_flux_instance",
        arguments: "{}",
      },
    ]);
    started.script.end();
    await called;
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${started.sessionId}/stop`,
    );
    expect(response.status).toBe(200);
    await Promise.race([
      waitDone(chat.app, started.sessionId),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("stop waited for the timeout")),
          1000,
        ),
      ),
    ]);
    expect(chat.app.sessions.byId(started.sessionId)?.status).toBe("stopped");
  });

  test("skips compact digests and regenerate compares with the turn before", async () => {
    const { chat, servers } = await sendFixture({});
    const first = await startChat(chat);
    first.script.reply("first answer");
    await waitDone(chat.app, first.sessionId);

    const compactPending = chat.scripted.next();
    const compactResponse = await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/compact`,
    );
    expect(compactResponse.status).toBe(200);
    const compact = await compactPending;
    expect(compact.body.tools).toBeUndefined();
    compact.reply("summary");
    await waitDone(chat.app, first.sessionId);

    await saveServers(chat, [], "auto");
    const secondPending = chat.scripted.next();
    await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/messages`,
      {
        body: { message: "second" },
      },
    );
    const second = await secondPending;
    const secondSystem = (
      second.body.messages as { role: string; content: string }[]
    )[0]!.content;
    expect(secondSystem).toContain("- flux: no longer available");
    second.reply("second answer");
    await waitDone(chat.app, first.sessionId);

    await saveServers(chat, servers, "auto");
    const regeneratePending = chat.scripted.next();
    const regenerate = await chat.member.call(
      "POST",
      `/api/sessions/${first.sessionId}/regenerate`,
    );
    expect(regenerate.status).toBe(201);
    const regenerated = await regeneratePending;
    const regeneratedSystem = (
      regenerated.body.messages as { role: string; content: string }[]
    )[0]!.content;
    expect(regeneratedSystem).not.toContain("Since your last turn");
    expect(toolNames(regenerated.body)).toContain(
      "mcp__flux__get_flux_instance",
    );
    regenerated.reply("regenerated");
    await waitDone(chat.app, first.sessionId);

    const sends = chat.app.db
      .query<{ kind: string; mcp: string | null }, [string]>(
        "select kind, mcp from sends where session_id = ? order by started_at, rowid",
      )
      .all(first.sessionId);
    expect(sends.find((send) => send.kind === "compact")?.mcp).toBeNull();
  });

  test("stores one digest for repeated sends and sweeps an orphan", async () => {
    const { chat } = await sendFixture({});
    const started = await startChat(chat);
    started.script.reply("done");
    await waitDone(chat.app, started.sessionId);
    const digest = {
      flux: {
        tools: {
          mcp__flux__z: "same-z",
          "mcp__flux__a-b": "same-a",
        },
        instructions: null,
      },
      docs: {
        tools: { mcp__docs__search: "same-docs" },
        instructions: null,
      },
    };
    const reordered = {
      docs: digest.docs,
      flux: {
        ...digest.flux,
        tools: {
          "mcp__flux__a-b": "same-a",
          mcp__flux__z: "same-z",
        },
      },
    };
    for (let index = 0; index < 100; index++) {
      chat.app.sessions.createSend({
        id: `digest-${index}`,
        sessionId: started.sessionId,
        userId: chat.memberId,
        agentId: chat.agentId,
        providerId: chat.providerId,
        model: "model",
        firstMessageId: "message",
        mcpDigest: index % 2 === 0 ? digest : reordered,
        now: chat.app.now.value + index,
      });
    }
    expect(
      chat.app.db
        .query<{ n: number }, []>(
          `select count(distinct mcp) as n from sends
           where id like 'digest-%'`,
        )
        .get()!.n,
    ).toBe(1);
    chat.app.db
      .query("insert into mcp_digests (key, body) values ('orphan', '{}')")
      .run();
    chat.app.sweep();
    expect(
      chat.app.db
        .query<{ n: number }, []>(
          "select count(*) as n from mcp_digests where key = 'orphan'",
        )
        .get()!.n,
    ).toBe(0);
  });
});
