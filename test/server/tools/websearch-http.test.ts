// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  retryAfterMs,
  searchWeb,
} from "../../../src/server/tools/builtin/websearch.ts";
import {
  budget,
  context,
  dependencies,
  exaResponse,
  search,
  streamResponse,
  thrown,
} from "./websearch.helpers.ts";

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
