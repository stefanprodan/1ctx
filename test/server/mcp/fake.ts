// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type RecordedMcp = {
  initialize: Record<string, unknown>;
  tools: { tools: Record<string, unknown>[] };
};

export type McpRequest = {
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
};

export async function fixture(name = "flux"): Promise<RecordedMcp> {
  return Bun.file(`test/fixtures/mcp/${name}.json`).json();
}

function rpc(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function response(body: unknown, sse: boolean, headers = new Headers()) {
  const text = JSON.stringify(body);
  if (sse) {
    headers.set("content-type", "text/event-stream");
    return new Response(`event: message\ndata: ${text}\n\n`, { headers });
  }
  headers.set("content-type", "application/json");
  return new Response(text, { headers });
}

export function mcpFetch(options: {
  era?: "modern" | "legacy";
  recorded: RecordedMcp;
  sse?: boolean;
  sessionId?: string;
  deleteStatus?: number;
  callResult?: Record<string, unknown>;
  mutateResult?: (
    method: string,
    result: Record<string, unknown>,
    body: Record<string, unknown>,
  ) => Record<string, unknown>;
}): { fetcher: typeof fetch; requests: McpRequest[] } {
  const requests: McpRequest[] = [];
  const era = options.era ?? "modern";
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    const headers = new Headers(request.headers);
    if (request.method === "DELETE") {
      requests.push({ method: "DELETE", headers, body: {} });
      return new Response("", { status: options.deleteStatus ?? 200 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    const method = String(body.method ?? "");
    requests.push({ method, headers, body });
    if (method === "server/discover" && era === "legacy") {
      return new Response("not found", { status: 404 });
    }
    if (!("id" in body)) return new Response(null, { status: 202 });
    let result: Record<string, unknown>;
    if (method === "server/discover") {
      const initialized = options.recorded.initialize;
      result = {
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "public",
        supportedVersions: ["2026-07-28"],
        capabilities: initialized.capabilities ?? { tools: {} },
        instructions: initialized.instructions,
        _meta: {
          "io.modelcontextprotocol/serverInfo": initialized.serverInfo,
        },
      };
    } else if (method === "initialize") {
      result = options.recorded.initialize;
    } else if (method === "tools/list") {
      result = {
        ...(era === "modern"
          ? { resultType: "complete", ttlMs: 0, cacheScope: "public" }
          : {}),
        ...options.recorded.tools,
      };
    } else if (method === "tools/call") {
      result = {
        ...(era === "modern" ? { resultType: "complete" } : {}),
        ...(options.callResult ?? {
          content: [{ type: "text", text: "called" }],
        }),
      };
    } else {
      return response(
        {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "method not found" },
        },
        options.sse ?? false,
      );
    }
    result = options.mutateResult?.(method, result, body) ?? result;
    const responseHeaders = new Headers();
    if (options.sessionId && method === "initialize") {
      responseHeaders.set("mcp-session-id", options.sessionId);
    }
    return response(
      rpc(body.id, result),
      options.sse ?? false,
      responseHeaders,
    );
  }) as typeof fetch;
  return { fetcher, requests };
}
