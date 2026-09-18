// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Requests use only the snapshotted provider and its current key.
// The fetch is a fake, so the suite never reaches a network.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import {
  buildRequest as buildExaRequest,
  EXA_URL,
} from "../../../src/server/tools/builtin/search/exa.ts";
import {
  buildRequest as buildFirecrawlRequest,
  FIRECRAWL_URL,
} from "../../../src/server/tools/builtin/search/firecrawl.ts";
import {
  buildRequest as buildTavilyRequest,
  TAVILY_URL,
} from "../../../src/server/tools/builtin/search/tavily.ts";
import {
  makeWebsearchTool,
  parseArgs,
  searchWeb,
} from "../../../src/server/tools/builtin/websearch.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import { memoryDb } from "../../helpers/db.ts";
import {
  budget,
  context,
  dependencies,
  exaResponse,
  firecrawlResponse,
  search,
  streamResponse,
  tavilyResponse,
  thrown,
} from "./websearch.helpers.ts";

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
    const secrets: Record<string, string> = { "search-exa": "exa-key" };
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
    const secrets: Record<string, string> = { "search-exa": "exa-key" };
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
    const secrets: Record<string, string> = { "search-exa": "exa-key" };
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
    delete secrets["search-exa"];
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
