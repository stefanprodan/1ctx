// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// websearch: the argument parsing, the provider bodies and their
// error mapping, the HTTP policy, the limits and cancellation, the
// User-Agent, and the key read in the area (a key gone since offered() is
// a failed result, never a switch). Hosts are the providers' own; the
// fetch is a fake, so the suite never reaches a network.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import {
  buildRequest as buildExaRequest,
  EXA_URL,
  parseAnswer as parseExaAnswer,
} from "../../../src/server/tools/builtin/search/exa.ts";
import {
  buildRequest as buildFirecrawlRequest,
  FIRECRAWL_URL,
  parseAnswer as parseFirecrawlAnswer,
} from "../../../src/server/tools/builtin/search/firecrawl.ts";
import {
  buildRequest as buildTavilyRequest,
  parseAnswer as parseTavilyAnswer,
  TAVILY_URL,
} from "../../../src/server/tools/builtin/search/tavily.ts";
import type { SearchProvider } from "../../../src/server/tools/builtin/search/types.ts";
import {
  makeWebsearchTool,
  parseArgs,
  retryAfterMs,
  type Search,
  type SearchDependencies,
  searchWeb,
} from "../../../src/server/tools/builtin/websearch.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import type {
  ToolBudget,
  ToolContext,
} from "../../../src/server/tools/types.ts";
import { memoryDb } from "../../helpers/db.ts";

const exaFixture = await Bun.file(
  new URL("../../fixtures/tools/exa-search.txt", import.meta.url),
).text();
const firecrawlFixture = await Bun.file(
  new URL("../../fixtures/tools/firecrawl-search.json", import.meta.url),
).text();
const tavilyFixture = await Bun.file(
  new URL("../../fixtures/tools/tavily-search.json", import.meta.url),
).text();
const exaPayload = exaFixture
  .split(/\r?\n/u)
  .find((line) => line.startsWith("data: "))!
  .slice(6);
const exaText = JSON.parse(exaPayload).result.content[0].text as string;
const successEnvelope = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "result" }] },
});

function budget(): ToolBudget {
  return { fetches: 0, searches: 0, visualBytes: 0 };
}

function context(
  signal = new AbortController().signal,
  shared = budget(),
  deadlineMs = 10_000,
): ToolContext {
  return {
    signal,
    now: Date.now,
    budget: shared,
    caps: { ...TOOL_CAPS, searchDeadlineMs: deadlineMs },
  };
}

function search(
  provider: SearchProvider = "exa",
  key: string | null = null,
): Search {
  return { provider, key };
}

function dependencies(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  sleep?: SearchDependencies["sleep"],
): SearchDependencies {
  return {
    fetch: fetcher as typeof fetch,
    sleep:
      sleep ??
      (async (_ms, signal) => {
        signal.throwIfAborted();
      }),
  };
}

function streamResponse(
  chunks: Array<string | Uint8Array>,
  init: ResponseInit = {},
  cancelled?: () => void,
  close = true,
  cancelOutcome: "settle" | "reject" | "hang" = "settle",
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          );
        }
        if (close) controller.close();
      },
      cancel() {
        cancelled?.();
        if (cancelOutcome === "reject") return Promise.reject(new Error("no"));
        if (cancelOutcome === "hang") return new Promise<void>(() => {});
        return undefined;
      },
    }),
    init,
  );
}

function exaResponse(text = successEnvelope): Response {
  return streamResponse([text], {
    headers: { "content-type": "application/json" },
  });
}

function firecrawlResponse(): Response {
  return streamResponse(
    [JSON.stringify({ success: true, data: { web: [] } })],
    {
      headers: { "content-type": "application/json" },
    },
  );
}

function tavilyResponse(): Response {
  return streamResponse([JSON.stringify({ results: [] })], {
    headers: { "content-type": "application/json" },
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject");
}

describe("websearch arguments", () => {
  test("validates and normalizes query and domain", () => {
    for (const value of [undefined, 7]) {
      expect(() => parseArgs({ query: value })).toThrow(
        "query must be a string",
      );
    }
    for (const value of ["", "   ", "x", " x "]) {
      expect(() => parseArgs({ query: value })).toThrow(
        "query must be at least 2 characters",
      );
    }
    expect(parseArgs({ query: " go " }).query).toBe("go");
    // counted by code point: one emoji is one character, two are two
    expect(() => parseArgs({ query: "\u{1f600}" })).toThrow(
      "query must be at least 2 characters",
    );
    expect(parseArgs({ query: "\u{1f600}\u{1f600}" }).query).toBe(
      "\u{1f600}\u{1f600}",
    );
    expect(parseArgs({ query: "\u{1f600}".repeat(500) }).query).toHaveLength(
      1000,
    );
    expect(() => parseArgs({ query: "x".repeat(501) })).toThrow(
      "query must be at most 500 characters",
    );
    expect(parseArgs({ query: "  find docs  " })).toEqual({
      query: "find docs",
      domain: null,
    });
    expect(parseArgs({ query: "find", domain: " FluxCD.io " })).toEqual({
      query: "find",
      domain: "fluxcd.io",
    });
    expect(parseArgs({ query: "find", domain: "fluxcd.io." }).domain).toBe(
      "fluxcd.io",
    );
  });

  test("refuses domains outside the fixed host-name rule", () => {
    for (const domain of [
      "https://fluxcd.io",
      "fluxcd.io/flux",
      "fluxcd.io:443",
      "*.fluxcd.io",
      "flux cd.io",
      "localhost",
      "",
      `${"a".repeat(251)}.io`,
    ]) {
      expect(() => parseArgs({ query: "find", domain }), domain).toThrow(
        "domain must be a host name with at least two labels and at most 253 characters",
      );
    }
  });
});

describe("provider requests", () => {
  test("builds the exact Exa envelope with the 1ctx User-Agent", async () => {
    const request = buildExaRequest(
      { query: "latest kubernetes version", domain: null },
      null,
      "vtest",
    );
    expect(request).toEqual({
      url: EXA_URL,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "1ctx/vtest",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: { query: "latest kubernetes version", numResults: 5 },
        },
      }),
    });
    expect(
      JSON.parse(
        buildExaRequest(
          { query: "ssh", domain: "fluxcd.io" },
          "secret",
          "vtest",
        ).body,
      ).params.arguments,
    ).toEqual({ query: "ssh site:fluxcd.io", numResults: 5 });
    expect(
      buildExaRequest({ query: "ssh", domain: "fluxcd.io" }, "secret", "vtest")
        .headers["x-api-key"],
    ).toBe("secret");

    const seen: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    await searchWeb(
      { query: "find" },
      context(),
      search(),
      "vtest",
      dependencies(async (input, init) => {
        seen.push({ input, init });
        return exaResponse();
      }),
    );
    expect(String(seen[0].input)).toBe(EXA_URL);
    expect(seen[0].init?.method).toBe("POST");
    expect(seen[0].init?.redirect).toBe("error");
  });

  test("builds the exact Firecrawl body with the 1ctx User-Agent", () => {
    expect(
      buildFirecrawlRequest(
        { query: "latest kubernetes version", domain: null },
        null,
        "vtest",
        10_000,
      ),
    ).toEqual({
      url: FIRECRAWL_URL,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "1ctx/vtest",
      },
      body: JSON.stringify({
        query: "latest kubernetes version",
        limit: 5,
        timeout: 8000,
      }),
    });
    const restricted = buildFirecrawlRequest(
      { query: "ssh", domain: "fluxcd.io" },
      "secret",
      "vtest",
      30_000,
    );
    expect(restricted.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(restricted.body)).toEqual({
      query: "ssh",
      limit: 5,
      timeout: 28_000,
      includeDomains: ["fluxcd.io"],
    });
  });

  test("gives Firecrawl the deadline less its margin, a second at least", async () => {
    const timeout = (deadlineMs: number) =>
      JSON.parse(
        buildFirecrawlRequest(
          { query: "find", domain: null },
          null,
          "vtest",
          deadlineMs,
        ).body,
      ).timeout;
    expect(timeout(1000)).toBe(1000);
    expect(timeout(2500)).toBe(1000);
    expect(timeout(600_000)).toBe(598_000);
    let sent: unknown;
    const long = context(new AbortController().signal, budget(), 45_000);
    long.caps = { ...long.caps, callTimeoutMs: 60_000 };
    await searchWeb(
      { query: "find" },
      long,
      search("firecrawl"),
      "vtest",
      dependencies(async (_input, init) => {
        sent = JSON.parse(String(init?.body)).timeout;
        return firecrawlResponse();
      }),
    );
    expect(sent).toBe(43_000);
  });

  test("builds the exact Tavily body, keyless by header", () => {
    expect(
      buildTavilyRequest(
        { query: "latest kubernetes version", domain: null },
        null,
        "vtest",
      ),
    ).toEqual({
      url: TAVILY_URL,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "1ctx/vtest",
        "X-Tavily-Access-Mode": "keyless",
      },
      body: JSON.stringify({
        query: "latest kubernetes version",
        max_results: 5,
      }),
    });
    const restricted = buildTavilyRequest(
      { query: "ssh", domain: "fluxcd.io" },
      "secret",
      "vtest",
    );
    expect(restricted.headers.Authorization).toBe("Bearer secret");
    expect(restricted.headers["X-Tavily-Access-Mode"]).toBeUndefined();
    expect(JSON.parse(restricted.body)).toEqual({
      query: "ssh",
      max_results: 5,
      include_domains: ["fluxcd.io"],
    });
  });

  test("dispatches the chosen provider with only its selected key", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    for (const [provider, key] of [
      ["exa", "exa-key"],
      ["firecrawl", "firecrawl-key"],
      ["tavily", "tavily-key"],
    ] as const) {
      await searchWeb(
        { query: "find" },
        context(),
        search(provider, key),
        "vtest",
        dependencies(async (input, init) => {
          calls.push({
            url: String(input),
            headers: new Headers(init?.headers),
          });
          return provider === "exa"
            ? exaResponse()
            : provider === "firecrawl"
              ? firecrawlResponse()
              : tavilyResponse();
        }),
      );
    }
    expect(calls[0].url).toBe(EXA_URL);
    expect(calls[0].headers.get("x-api-key")).toBe("exa-key");
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(calls[1].url).toBe(FIRECRAWL_URL);
    expect(calls[1].headers.get("authorization")).toBe("Bearer firecrawl-key");
    expect(calls[1].headers.get("x-api-key")).toBeNull();
    expect(calls[2].url).toBe(TAVILY_URL);
    expect(calls[2].headers.get("authorization")).toBe("Bearer tavily-key");
    expect(calls[2].headers.get("x-tavily-access-mode")).toBeNull();
  });
});

describe("Exa answers", () => {
  test("returns the recorded SSE text byte for byte and accepts JSON", () => {
    expect(parseExaAnswer(exaFixture, "text/event-stream", false)).toBe(
      exaText,
    );
    expect(parseExaAnswer(exaPayload, "application/json", false)).toBe(exaText);
  });

  test("joins SSE data lines and multiple text items", () => {
    const split = `event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"content":[{"type":"text","text":"joined"}]}}\n\n`;
    expect(parseExaAnswer(split, "text/event-stream", false)).toBe("joined");
    const multiple = JSON.stringify({
      result: {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    });
    expect(parseExaAnswer(multiple, "application/json", false)).toBe(
      "one\n\ntwo",
    );
    expect(
      parseExaAnswer(
        JSON.stringify({ result: { content: [{ type: "text", text: " " }] } }),
        "application/json",
        false,
      ),
    ).toBe("No results.");
  });

  test("rejects malformed SSE, JSON and result shapes", () => {
    for (const [body, type] of [
      ["event: message\n\n", "text/event-stream"],
      ["event: message\ndata: nope\n\n", "text/event-stream"],
      [JSON.stringify({ result: { content: "bad" } }), "application/json"],
    ]) {
      expect(() => parseExaAnswer(body, type, false)).toThrow(
        "websearch answered with an unexpected shape",
      );
    }
  });

  test("passes server errors through and strips the MCP prefix", () => {
    expect(() =>
      parseExaAnswer(
        JSON.stringify({ error: { code: -32602, message: "bad params" } }),
        "application/json",
        false,
      ),
    ).toThrow("bad params");
    const unknown = JSON.stringify({
      result: {
        isError: true,
        content: [
          { type: "text", text: "MCP error -32602: Tool nope not found" },
        ],
      },
    });
    expect(() => parseExaAnswer(unknown, "application/json", false)).toThrow(
      "Tool nope not found",
    );
  });

  test("maps the recorded bad-key result only when a key was sent", async () => {
    const badKey = JSON.stringify({
      result: {
        isError: true,
        content: [
          { type: "text", text: "web_search_exa error (401): Invalid API key" },
        ],
      },
    });
    const keyed = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("exa", "bad"),
        "vtest",
        dependencies(async () => exaResponse(badKey)),
      ),
    );
    expect(keyed.message).toBe(
      "websearch key rejected: web_search_exa error (401): Invalid API key",
    );
    const keyless = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("exa"),
        "vtest",
        dependencies(async () => exaResponse(badKey)),
      ),
    );
    expect(keyless.message).toBe("web_search_exa error (401): Invalid API key");
  });
});

describe("Firecrawl answers", () => {
  test("formats the recorded hits", () => {
    const source = JSON.parse(firecrawlFixture).data.web as Array<{
      title: string;
      url: string;
      description: string;
    }>;
    const expected = source
      .map(
        (hit, index) =>
          `${index + 1}. ${hit.title}\n${hit.url}\n${hit.description}`,
      )
      .join("\n\n");
    expect(parseFirecrawlAnswer(firecrawlFixture)).toBe(expected);
  });

  test("skips missing URLs, keeps contiguous numbers and empty fields", () => {
    const answer = JSON.stringify({
      success: true,
      data: {
        web: [
          { title: "one", url: "https://one", description: "first" },
          { title: "drop", description: "missing URL" },
          { title: 3, url: "https://three", description: 3 },
        ],
      },
    });
    expect(parseFirecrawlAnswer(answer)).toBe(
      "1. one\nhttps://one\nfirst\n\n2. \nhttps://three\n",
    );
    expect(
      parseFirecrawlAnswer(
        JSON.stringify({ success: true, data: { web: [] } }),
      ),
    ).toBe("No results.");
  });

  test("reports provider and shape errors", () => {
    expect(() =>
      parseFirecrawlAnswer(JSON.stringify({ success: false, error: "denied" })),
    ).toThrow("denied");
    for (const body of [
      "not json",
      JSON.stringify({ success: true }),
      JSON.stringify({ success: true, data: {} }),
    ]) {
      expect(() => parseFirecrawlAnswer(body)).toThrow(
        "websearch answered with an unexpected shape",
      );
    }
  });
});

describe("Tavily answers", () => {
  test("formats the recorded hits", () => {
    const source = JSON.parse(tavilyFixture).results as Array<{
      title: string;
      url: string;
      content: string;
    }>;
    expect(source.length).toBeGreaterThan(0);
    const expected = source
      .map(
        (hit, index) =>
          `${index + 1}. ${hit.title}\n${hit.url}\n${hit.content}`,
      )
      .join("\n\n");
    expect(parseTavilyAnswer(tavilyFixture)).toBe(expected);
  });

  test("skips missing URLs, keeps contiguous numbers and empty fields", () => {
    const answer = JSON.stringify({
      results: [
        { title: "one", url: "https://one", content: "first" },
        { title: "drop", content: "missing URL" },
        { title: 3, url: "https://three", content: 3 },
      ],
    });
    expect(parseTavilyAnswer(answer)).toBe(
      "1. one\nhttps://one\nfirst\n\n2. \nhttps://three\n",
    );
    expect(parseTavilyAnswer(JSON.stringify({ results: [] }))).toBe(
      "No results.",
    );
  });

  test("reports a shape error", () => {
    for (const body of ["not json", "[]", JSON.stringify({ query: "x" })]) {
      expect(() => parseTavilyAnswer(body)).toThrow(
        "websearch answered with an unexpected shape",
      );
    }
  });
});

describe("websearch HTTP policy", () => {
  test("retries one 429, cancels it and reuses the deadline signal", async () => {
    let cancelled = 0;
    const sleeps: number[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    let calls = 0;
    const result = await searchWeb(
      { query: "find" },
      context(new AbortController().signal, budget(), 5000),
      search(),
      "vtest",
      dependencies(
        async (_input, init) => {
          signals.push(init?.signal);
          calls++;
          if (calls === 1) {
            return streamResponse(
              ["rate limited"],
              { status: 429, headers: { "retry-after": "1" } },
              () => cancelled++,
              false,
            );
          }
          return exaResponse();
        },
        async (ms, signal) => {
          signal.throwIfAborted();
          sleeps.push(ms);
        },
      ),
    );
    expect(result).toBe("result");
    expect(cancelled).toBe(1);
    expect(sleeps).toEqual([1000]);
    expect(signals[1]).toBe(signals[0]);
  });

  test("parses retry-after", () => {
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs("")).toBe(1000);
    expect(retryAfterMs("-1")).toBe(1000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("30")).toBeNull();
    expect(retryAfterMs("1.5")).toBeNull();
  });

  test("maps HTTP errors for both providers", async () => {
    for (const provider of ["exa", "firecrawl", "tavily"] as const) {
      const withText = await thrown(
        searchWeb(
          { query: "find" },
          context(),
          search(provider),
          "vtest",
          dependencies(async () =>
            streamResponse([JSON.stringify({ error: "server broke" })], {
              status: 500,
            }),
          ),
        ),
      );
      expect(withText.message).toBe(
        "websearch failed (HTTP 500): server broke",
      );
      const withoutText = await thrown(
        searchWeb(
          { query: "find" },
          context(),
          search(provider),
          "vtest",
          dependencies(async () =>
            streamResponse(["<html>bad gateway</html>"], { status: 502 }),
          ),
        ),
      );
      expect(withoutText.message).toBe("websearch failed (HTTP 502)");
    }
  });

  test("maps Firecrawl's keyless refusal and a rejected key", async () => {
    const refusal =
      '{"success":false,"error":"Unfortunately, your IP address looks suspicious, so Firecrawl can\'t be used without an API key from here."}';
    const refused = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("firecrawl"),
        "vtest",
        dependencies(async () => streamResponse([refusal], { status: 403 })),
      ),
    );
    expect(refused.message).toBe(
      "websearch refused: Unfortunately, your IP address looks suspicious, so Firecrawl can't be used without an API key from here.",
    );
    const rejected = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("firecrawl", "bad"),
        "vtest",
        dependencies(async () =>
          streamResponse(
            [JSON.stringify({ success: false, error: "Invalid API key" })],
            { status: 401 },
          ),
        ),
      ),
    );
    expect(rejected.message).toBe("websearch key rejected: Invalid API key");
  });

  test("maps Tavily's nested words for a rejected key and a refusal", async () => {
    const rejected = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("tavily", "bad"),
        "vtest",
        dependencies(async () =>
          streamResponse(
            [
              JSON.stringify({
                detail: { error: "Unauthorized: missing or invalid API key." },
              }),
            ],
            { status: 401 },
          ),
        ),
      ),
    );
    expect(rejected.message).toBe(
      "websearch key rejected: Unauthorized: missing or invalid API key.",
    );
    const refused = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("tavily"),
        "vtest",
        dependencies(async () =>
          streamResponse([JSON.stringify({ detail: { error: "Too many" } })], {
            status: 403,
          }),
        ),
      ),
    );
    expect(refused.message).toBe("websearch refused: Too many");
  });

  test("cleans and bounds server error text", async () => {
    const dirty = ` first\nsecond\u0000\tthird ${"x".repeat(5000)}`;
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search(),
        "vtest",
        dependencies(async () =>
          streamResponse([JSON.stringify({ error: dirty })], { status: 500 }),
        ),
      ),
    );
    expect(error.message).toStartWith(
      "websearch failed (HTTP 500): first second third ",
    );
    expect(error.message).not.toContain("\n");
    expect(error.message).not.toContain("\u0000");
  });
});

describe("websearch limits and cancellation", () => {
  test("cancels and reports a body over 1 MB", async () => {
    let cancelled = 0;
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search(),
        "vtest",
        dependencies(async () =>
          streamResponse(
            [new Uint8Array(1024 * 1024), new Uint8Array([1])],
            { headers: { "content-type": "application/json" } },
            () => cancelled++,
            false,
          ),
        ),
      ),
    );
    expect(error.message).toBe("websearch answer over 1 MB");
    expect(cancelled).toBe(1);
  });

  test("names the cap an admin set when a body is over it", async () => {
    const ctx = context();
    ctx.caps = { ...ctx.caps, searchBodyBytes: 64 * 1024 };
    const error = await thrown(
      searchWeb(
        { query: "find" },
        ctx,
        search("tavily"),
        "vtest",
        dependencies(async () =>
          streamResponse([new Uint8Array(64 * 1024 + 1)], {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    expect(error.message).toBe("websearch answer over 64 KB");
  });

  test("enforces three searches synchronously across parallel calls", async () => {
    const shared = budget();
    let fetches = 0;
    const calls = Array.from({ length: 4 }, () =>
      searchWeb(
        { query: "find" },
        context(new AbortController().signal, shared),
        search(),
        "vtest",
        dependencies(async () => {
          fetches++;
          return exaResponse();
        }),
      ),
    );
    const results = await Promise.allSettled(calls);
    expect(fetches).toBe(3);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(rejected?.reason.message).toBe("search limit reached");
  });

  test("times out a fetch that ignores the signal", async () => {
    const error = await thrown(
      searchWeb(
        { query: "find" },
        context(new AbortController().signal, budget(), 30),
        search(),
        "vtest",
        dependencies(async () => new Promise<Response>(() => {})),
      ),
    );
    expect(error.message).toBe("search timed out after 0.03 seconds");
  });

  test("propagates the caller abort reason before any request", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    let called = false;
    expect(
      await thrown(
        searchWeb(
          { query: "find" },
          context(controller.signal),
          search("exa"),
          "vtest",
          dependencies(async () => {
            called = true;
            return exaResponse();
          }),
        ),
      ),
    ).toBe(reason);
    expect(called).toBe(false);
  });
});

describe("the area reads the key at each call", () => {
  function areaWith(secrets: Record<string, string>, fetcher: typeof fetch) {
    const area = toolsArea({
      db: memoryDb(),
      fetcher,
      secret: (name) => secrets[name] ?? null,
      clock: Date.now,
      log: silent,
      version: "vtest",
      render: (md) => md,
      searchDeps: dependencies(fetcher as never),
      skills: { forAgent: () => [], body: () => null, file: () => null },
    });
    area.store.setProvider("exa", Date.now());
    return area;
  }

  test("runs websearch with the exa key read from secrets", async () => {
    const secrets: Record<string, string> = { exa: "exa-key" };
    let sentKey: string | null = null;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentKey = new Headers(init?.headers).get("x-api-key");
      return exaResponse();
    }) as typeof fetch;
    const area = areaWith(secrets, fetcher);
    const offered = area.offered(Date.now(), "");
    expect(offered.search).toBe("exa");
    const result = await area.run(
      offered,
      { id: "s", name: "websearch", arguments: '{"query":"find"}' },
      context(),
    );
    expect(result.error).toBe(false);
    expect(result.content).toBe("result");
    expect(sentKey as string | null).toBe("exa-key");
  });

  test("scrubs the selected key from an error", async () => {
    const secrets: Record<string, string> = { exa: "exa-key" };
    const fetcher = (async () => {
      throw new Error("request with exa-key failed");
    }) as unknown as typeof fetch;
    const area = areaWith(secrets, fetcher);
    const result = await area.run(
      area.offered(Date.now(), ""),
      { id: "s", name: "websearch", arguments: '{"query":"find"}' },
      context(),
    );
    expect(result.error).toBe(true);
    expect(result.content).toContain("[key]");
    expect(result.content).not.toContain("exa-key");
  });
  test("a key removed since offered() runs keyless, never a switch", async () => {
    const secrets: Record<string, string> = { exa: "exa-key" };
    let sentKey: string | null | undefined;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentKey = new Headers(init?.headers).get("x-api-key");
      // the provider rejects a keyless call the way Exa's recorded 401 does
      return exaResponse(
        JSON.stringify({
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "web_search_exa error (401): Invalid API key",
              },
            ],
          },
        }),
      );
    }) as typeof fetch;
    const area = areaWith(secrets, fetcher);
    const offered = area.offered(Date.now(), "");
    expect(offered.search).toBe("exa");
    // the file is gone before the call runs
    delete secrets.exa;
    const result = await area.run(
      offered,
      { id: "s", name: "websearch", arguments: '{"query":"find"}' },
      context(),
    );
    // the provider snapshot stays Exa and the call runs keyless: no key
    // header, never a switch to Firecrawl; this fake provider refuses
    // the keyless call, which is the tool's failed result
    expect(sentKey).toBeNull();
    expect(result.error).toBe(true);
    expect(result.content).toContain("401");
  });
});

describe("websearch review fixes", () => {
  test("a key echoed in a successful answer is scrubbed", async () => {
    const tool = makeWebsearchTool(
      () => "tvly-secret",
      "tavily",
      "vtest",
      dependencies(async () =>
        streamResponse(
          [
            JSON.stringify({
              results: [
                {
                  title: "tvly-secret",
                  url: "https://one.example/?k=tvly-secret",
                  content: "your key is tvly-secret",
                },
              ],
            }),
          ],
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const result = await tool.run({ query: "find" }, context());
    expect(result).not.toContain("tvly-secret");
    expect(result).toBe(
      "1. [key]\nhttps://one.example/?k=[key]\nyour key is [key]",
    );
  });

  test("a keyed 401 and a keyless 403 without readable words keep their meaning", async () => {
    for (const body of ["", "<html>denied</html>"]) {
      const rejected = await thrown(
        searchWeb(
          { query: "find" },
          context(),
          search("tavily", "bad"),
          "vtest",
          dependencies(async () => streamResponse([body], { status: 401 })),
        ),
      );
      expect(rejected.message).toBe("websearch key rejected");
      const refused = await thrown(
        searchWeb(
          { query: "find" },
          context(),
          search("firecrawl"),
          "vtest",
          dependencies(async () => streamResponse([body], { status: 403 })),
        ),
      );
      expect(refused.message).toBe("websearch refused");
    }
    // a keyless 401 and a keyed 403 are plain failures
    const keyless401 = await thrown(
      searchWeb(
        { query: "find" },
        context(),
        search("tavily"),
        "vtest",
        dependencies(async () => streamResponse([""], { status: 401 })),
      ),
    );
    expect(keyless401.message).toBe("websearch failed (HTTP 401)");
  });

  test("the provider timeout and the retry wait follow a shorter call timeout", async () => {
    const ctx = context(new AbortController().signal, budget(), 600_000);
    ctx.caps = { ...ctx.caps, callTimeoutMs: 5000 };
    let timeout: unknown;
    await searchWeb(
      { query: "find" },
      ctx,
      search("firecrawl"),
      "vtest",
      dependencies(async (_input, init) => {
        timeout = JSON.parse(String(init?.body)).timeout;
        return firecrawlResponse();
      }),
    );
    expect(timeout).toBe(3000);

    // a retry-after of 6 s fits the search deadline but not the call's
    const sleeps: number[] = [];
    const limited = await thrown(
      searchWeb(
        { query: "find" },
        ctx,
        search("tavily"),
        "vtest",
        dependencies(
          async () =>
            streamResponse([""], {
              status: 429,
              headers: { "retry-after": "6" },
            }),
          async (ms) => {
            sleeps.push(ms);
          },
        ),
      ),
    );
    expect(limited.message).toBe(
      "websearch rate limited, try again in a moment",
    );
    expect(sleeps).toEqual([]);
  });
});
