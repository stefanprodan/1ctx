// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Three fake MCP servers on one port, Streamable HTTP in the legacy era
// the server's client falls back to (server/discover is a 404):
// /cluster/mcp, /git/mcp, /docs/mcp, 93 tools (catalog.ts). A call
// sleeps latencyMs(tool, args), the same time the fake model planned
// for it, then answers resultText. One JSON line per call on stdout.
//
// bun scripts/load/fake-mcp.ts
// env: PORT (1250), HOST (127.0.0.1)

import { type McpServer, SERVERS, toolDef } from "./catalog.ts";
import { latencyMs } from "./latency.ts";
import { resultText } from "./mcp-results.ts";
import { FAKE } from "./shapes.ts";

export type McpOptions = {
  sleep?: (ms: number) => Promise<unknown>;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
};

const reply = (id: unknown, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result });

const rpcError = (id: unknown, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

export function createMcp(options: McpOptions = {}) {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = options.log ?? ((e) => console.log(JSON.stringify(e)));
  const now = options.now ?? Date.now;

  async function handle(server: McpServer, req: Request): Promise<Response> {
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    // no standalone SSE stream
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    const method = String(body.method ?? "");
    if (method === "server/discover") {
      return new Response("not found", { status: 404 });
    }
    if (!("id" in body)) return new Response(null, { status: 202 });
    const params = (body.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "initialize":
        return reply(body.id, {
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `fake-${server.name}`, version: "1.0.0" },
          instructions: server.instructions,
        });
      case "ping":
        return reply(body.id, {});
      case "tools/list":
        return reply(body.id, {
          tools: server.tools.map((t) => toolDef(server.name, t)),
        });
      case "tools/call": {
        const tool = String(params.name ?? "");
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!server.tools.includes(tool)) {
          return rpcError(body.id, -32602, `unknown tool ${tool}`);
        }
        const at = now();
        const ms = latencyMs(tool, args);
        await sleep(ms);
        const text = resultText(server.name, tool, args);
        const bytes = Buffer.byteLength(text);
        log({ t: "call", at, server: server.name, tool, ms, bytes });
        return reply(body.id, {
          content: [{ type: "text", text }],
          isError: false,
        });
      }
      default:
        return rpcError(body.id, -32601, "method not found");
    }
  }

  function fetch(req: Request): Promise<Response> | Response {
    const path = new URL(req.url).pathname;
    if (path === "/health") return new Response("ok");
    const m = /^\/([a-z]+)\/mcp\/?$/.exec(path);
    const server = m ? SERVERS[m[1]!] : undefined;
    if (server === undefined) return new Response("not found", { status: 404 });
    return handle(server, req);
  }

  return { fetch };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? FAKE.mcpPort);
  Bun.serve({
    hostname: process.env.HOST ?? "127.0.0.1",
    port,
    idleTimeout: 60,
    fetch: createMcp().fetch,
  });
  console.error(`fake mcp on ${port}: /cluster/mcp, /git/mcp, /docs/mcp`);
}
