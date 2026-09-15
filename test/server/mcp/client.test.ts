// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { withClient } from "../../../src/server/mcp/client.ts";
import { discover, fingerprint } from "../../../src/server/mcp/discover.ts";
import { fixture, mcpFetch } from "./fake.ts";

const URL = "https://hands.test/mcp";
const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 2_000,
  bodyBytes: 2 * 1024 * 1024,
});

describe("MCP SDK client", () => {
  test("negotiates the modern era and emits modern headers", async () => {
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    const info = await withClient(
      { fetcher: fake.fetcher, version: "test" },
      { url: URL },
      null,
      options(),
      async (client) => {
        await client.listTools();
        return client.info();
      },
    );
    expect(fake.requests.map((request) => request.method)).toEqual([
      "server/discover",
      "tools/list",
    ]);
    expect(
      fake.requests.some((request) => request.method === "initialize"),
    ).toBeFalse();
    const list = fake.requests[1];
    expect(list.headers.get("mcp-method")).toBe("tools/list");
    expect(list.headers.get("mcp-name")).toBeNull();
    expect((list.body.params as Record<string, unknown>)._meta).toBeObject();
    expect(info.protocolEra).toBe("modern");
    expect(info.protocolVersion).toBe("2026-07-28");
    expect(info.serverName).toBe("flux-operator-mcp");
  });

  test("falls back to the legacy handshake", async () => {
    const recorded = await fixture("flux-docs");
    const fake = mcpFetch({ era: "legacy", recorded });
    const info = await withClient(
      { fetcher: fake.fetcher, version: "test" },
      { url: URL },
      null,
      options(),
      async (client) => client.info(),
    );
    expect(fake.requests.map((request) => request.method)).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
    ]);
    expect(info.protocolEra).toBe("legacy");
    expect(info.protocolVersion).toBe("2025-06-18");
    expect(info.instructions).toContain("Search and retrieval tools");
  });

  test("reads JSON and SSE call results", async () => {
    const recorded = await fixture();
    for (const sse of [false, true]) {
      const fake = mcpFetch({ recorded, sse });
      const text = await withClient(
        { fetcher: fake.fetcher, version: "test" },
        { url: URL },
        null,
        options(),
        async (client) => {
          const result = await client.callTool(
            "echo",
            {},
            {
              name: "echo",
              description: "Echo",
              inputSchema: { type: "object", properties: {} },
            },
            { signal: options().signal, timeoutMs: 2_000 },
          );
          const part = result.content?.[0];
          return typeof part?.text === "string" ? part.text : "";
        },
      );
      expect(text).toBe("called");
    }
  });

  test("sends bearer auth and scrubs the key", async () => {
    const recorded = await fixture();
    const key = "top-secret-value";
    const fake = mcpFetch({
      recorded,
      callResult: {
        content: [{ type: "text", text: `echo ${key}` }],
        isError: true,
      },
    });
    await expect(
      withClient(
        { fetcher: fake.fetcher, version: "test" },
        { url: URL },
        key,
        options(),
        async (client) => {
          const result = await client.callTool(
            "echo",
            {},
            {
              name: "echo",
              inputSchema: { type: "object", properties: {} },
            },
            { signal: options().signal, timeoutMs: 2_000 },
          );
          const part = result.content?.[0];
          throw new Error(typeof part?.text === "string" ? part.text : "");
        },
      ),
    ).rejects.toThrow("echo [redacted]");
    expect(fake.requests[0].headers.get("authorization")).toBe(`Bearer ${key}`);
  });

  test("scrubs the key from response headers before the SDK sees them", async () => {
    const recorded = await fixture("flux-docs");
    const key = "top-secret-value";
    const fake = mcpFetch({ era: "legacy", recorded });
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      if (request.method === "DELETE") return fake.fetcher(request);
      const body = (await request.clone().json()) as { method?: string };
      const response = await fake.fetcher(request);
      if (body.method !== "initialize") return response;
      const headers = new Headers(response.headers);
      headers.set("mcp-session-id", key);
      return new Response(response.body, { headers });
    }) as typeof fetch;
    await withClient(
      { fetcher, version: "test" },
      { url: URL },
      key,
      options(),
      async (client) => client.listTools(),
    );
    const list = fake.requests.find(
      (request) => request.method === "tools/list",
    );
    const deleted = fake.requests.find(
      (request) => request.method === "DELETE",
    );
    expect(list?.headers.get("mcp-session-id")).toBe("[redacted]");
    expect(deleted?.headers.get("mcp-session-id")).toBe("[redacted]");
  });

  test("uses a tool definition without listing tools", async () => {
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    await withClient(
      { fetcher: fake.fetcher, version: "test" },
      { url: URL },
      null,
      options(),
      async (client) => {
        await client.callTool(
          "repo",
          { owner: "acme" },
          {
            name: "repo",
            inputSchema: {
              type: "object",
              properties: {
                owner: { type: "string", "x-mcp-header": "owner" },
              },
            },
          },
          { signal: options().signal, timeoutMs: 2_000 },
        );
      },
    );
    expect(fake.requests.map((request) => request.method)).toEqual([
      "server/discover",
      "tools/call",
    ]);
    expect(fake.requests[1].headers.get("mcp-param-owner")).toBe("acme");
  });

  test("terminates a legacy session before closing", async () => {
    const recorded = await fixture();
    const fake = mcpFetch({
      era: "legacy",
      recorded,
      sessionId: "session-1",
      deleteStatus: 500,
    });
    await withClient(
      { fetcher: fake.fetcher, version: "test" },
      { url: URL },
      null,
      options(),
      async () => "done",
    );
    const deleted = fake.requests.at(-1)!;
    expect(deleted.method).toBe("DELETE");
    expect(deleted.headers.get("mcp-session-id")).toBe("session-1");
  });

  test("keeps list requests inside the client deadline", async () => {
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      const body = (await request.clone().json()) as { method?: string };
      if (body.method !== "tools/list") return fake.fetcher(request);
      return new Promise<Response>((_resolve, reject) => {
        const stop = () => reject(request.signal.reason);
        if (request.signal.aborted) stop();
        else request.signal.addEventListener("abort", stop, { once: true });
      });
    }) as typeof fetch;
    const started = Date.now();
    await expect(
      withClient(
        { fetcher, version: "test" },
        { url: URL },
        null,
        { ...options(), timeoutMs: 100 },
        async (client) => client.listTools(),
      ),
    ).rejects.toThrow("MCP request timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("keeps the abort listener through hanging session cleanup", async () => {
    const recorded = await fixture();
    const fake = mcpFetch({ era: "legacy", recorded, sessionId: "session-1" });
    let deleteEnded = false;
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const request =
        input instanceof Request ? input : new Request(String(input), init);
      if (request.method !== "DELETE") return fake.fetcher(request);
      return new Promise<Response>((_resolve, reject) => {
        const stop = () => {
          deleteEnded = true;
          reject(request.signal.reason);
        };
        if (request.signal.aborted) stop();
        else request.signal.addEventListener("abort", stop, { once: true });
      });
    }) as typeof fetch;
    const started = Date.now();
    await expect(
      withClient(
        { fetcher, version: "test" },
        { url: URL },
        null,
        { ...options(), timeoutMs: 100 },
        async () => "done",
      ),
    ).resolves.toBe("done");
    expect(deleteEnded).toBeTrue();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("maps a 401 to the key refusal", async () => {
    const fetcher = (async () =>
      new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(
      withClient(
        { fetcher, version: "test" },
        { url: URL },
        "wrong-key",
        options(),
        async () => null,
      ),
    ).rejects.toThrow("the server refused the key");
  });

  test("refuses a declared response over the shared budget", async () => {
    let cancelled = false;
    const fetcher = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "1000" } },
      )) as unknown as typeof fetch;
    await expect(
      withClient(
        { fetcher, version: "test" },
        { url: URL },
        null,
        { ...options(), bodyBytes: 100 },
        async () => null,
      ),
    ).rejects.toThrow("the server's answer is over 100 bytes");
    expect(cancelled).toBeTrue();
  });

  test("client metadata makes the same fingerprint as discovery", async () => {
    const recorded = await fixture();
    const fake = mcpFetch({ recorded });
    const found = await discover(
      { fetcher: fake.fetcher, version: "test", clock: () => 10 },
      { url: URL },
      null,
    );
    expect(found.fingerprint).toBe(
      fingerprint({
        serverName: found.serverName,
        serverVersion: found.serverVersion,
        instructions: found.instructions,
      }),
    );
  });
});

describe("MCP streamed response budget", () => {
  test("aborts a successful body that crosses the budget", async () => {
    const fetcher = (async () =>
      new Response("x".repeat(101), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      withClient(
        { fetcher, version: "test" },
        { url: URL },
        null,
        { ...options(), bodyBytes: 100 },
        async () => null,
      ),
    ).rejects.toThrow("the server's answer is over 100 bytes");
  });

  test("keeps the byte-cap error for an oversized HTTP error body", async () => {
    const fetcher = (async () =>
      new Response("x".repeat(101), {
        status: 500,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    await expect(
      withClient(
        { fetcher, version: "test" },
        { url: URL },
        null,
        { ...options(), bodyBytes: 100 },
        async () => null,
      ),
    ).rejects.toThrow("the server's answer is over 100 bytes");
  });
});
