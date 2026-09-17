// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// webfetch as a plain fetch: the URL guard, HTML extraction, slicing, the
// redirect limit, the body cut, the media-type and charset handling, the
// deadline and the User-Agent. There is no address classification, no
// resolver and no reachable-set (decision 2). The fetch is a fake, so the
// suite never reaches a network; hosts are made up.

import { describe, expect, test } from "bun:test";
import {
  extractHtml,
  type FetchDependencies,
  fetchText,
  makeWebfetchTool,
  parseFetchUrl,
  sliceContent,
} from "../../../src/server/tools/builtin/webfetch.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import type {
  ToolBudget,
  ToolContext,
} from "../../../src/server/tools/types.ts";

function context(signal = new AbortController().signal): ToolContext {
  const budget: ToolBudget = { fetches: 0, searches: 0, visualBytes: 0 };
  return { signal, now: () => 0, budget, caps: TOOL_CAPS };
}

function dependencies(
  response: (input: string, init: RequestInit) => Response | Promise<Response>,
): FetchDependencies {
  return {
    fetch: (async (input, init) =>
      response(String(input), init ?? {})) as typeof fetch,
  };
}

function textResponse(
  text: BodyInit = "ok",
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/plain; charset=utf-8");
  }
  return new Response(text, { ...init, headers });
}

const run = (args: Record<string, unknown>, deps: FetchDependencies) =>
  fetchText(args, context(), "vtest", deps);

describe("fetch URL guard", () => {
  test("normalizes upper-case hosts and trailing dots", () => {
    expect(parseFetchUrl("HTTPS://EXAMPLE.COM./path").href).toBe(
      "https://example.com/path",
    );
  });

  test("refuses unsupported schemes and URL credentials", () => {
    for (const url of [
      "file:///tmp/a",
      "data:text/plain,a",
      "blob:https://example.com/id",
      "s3://bucket/key",
    ]) {
      expect(() => parseFetchUrl(url), url).toThrow("is not allowed");
    }
    expect(() => parseFetchUrl("https://user:secret@example.com")).toThrow(
      "credentials in URLs are not allowed",
    );
  });

  test("rejects an empty url argument", async () => {
    await expect(
      run(
        { url: "" },
        dependencies(() => textResponse()),
      ),
    ).rejects.toThrow("url must be a non-empty string");
  });

  test("sets the User-Agent and manual redirect", async () => {
    let input = "";
    let options: RequestInit | undefined;
    const deps = dependencies((url, init) => {
      input = url;
      options = init;
      return textResponse("page");
    });
    const result = await run({ url: "https://PUBLIC.EXAMPLE./path?q=1" }, deps);
    expect(result).toBe("page");
    expect(input).toBe("https://public.example/path?q=1");
    expect(new Headers(options?.headers).get("user-agent")).toBe("1ctx/vtest");
    expect(options?.redirect).toBe("manual");
  });

  test("follows redirects and stops after three hops", async () => {
    let calls = 0;
    const deps = dependencies(() => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: `/hop-${calls}` },
      });
    });
    await expect(
      run({ url: "https://public.example/start" }, deps),
    ).rejects.toThrow("redirect limit exceeded after 3 hops");
    expect(calls).toBe(4);
  });

  test("follows a redirect to its target", async () => {
    let calls = 0;
    const deps = dependencies((url) => {
      calls++;
      if (calls === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://public.example/moved" },
        });
      }
      expect(url).toBe("https://public.example/moved");
      return textResponse("moved page");
    });
    expect(await run({ url: "https://public.example/start" }, deps)).toBe(
      "moved page",
    );
    expect(calls).toBe(2);
  });

  test("refuses a redirect to an unsupported scheme", async () => {
    const deps = dependencies(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "file:///etc/passwd" },
        }),
    );
    await expect(
      run({ url: "https://public.example/start" }, deps),
    ).rejects.toThrow("redirect refused:");
  });

  test("enforces the fetch budget", async () => {
    const shared: ToolBudget = {
      fetches: TOOL_CAPS.maxFetches,
      searches: 0,
      visualBytes: 0,
    };
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      now: () => 0,
      budget: shared,
      caps: TOOL_CAPS,
    };
    await expect(
      fetchText(
        { url: "https://public.example/" },
        ctx,
        "vtest",
        dependencies(() => textResponse()),
      ),
    ).rejects.toThrow("fetch limit reached");
  });
});

describe("fetch response", () => {
  test("cuts the decoded body at 2 MB and notes the cut", async () => {
    const limit = 2 * 1024 * 1024;
    const bytes = new Uint8Array(limit + 1).fill("a".charCodeAt(0));
    const deps = dependencies(
      () => new Response(bytes, { headers: { "content-type": "text/plain" } }),
    );
    const result = await fetchText(
      {
        url: "https://public.example/large",
        start_index: limit - 50,
        max_length: 500,
      },
      context(),
      "vtest",
      deps,
    );
    expect(result).toBe(
      `${"a".repeat(50)}\n\n<error>Content truncated at 2 MB.</error>`,
    );
  });

  test("notes the cut at the cap an admin set", async () => {
    const limit = 64 * 1024;
    const bytes = new Uint8Array(limit + 1).fill("a".charCodeAt(0));
    const ctx = context();
    ctx.caps = { ...ctx.caps, fetchBodyBytes: limit };
    const result = await fetchText(
      {
        url: "https://public.example/large",
        start_index: limit - 10,
        max_length: 500,
      },
      ctx,
      "vtest",
      dependencies(
        () =>
          new Response(bytes, { headers: { "content-type": "text/plain" } }),
      ),
    );
    expect(result).toBe(
      `${"a".repeat(10)}\n\n<error>Content truncated at 64 KB.</error>`,
    );
  });

  test("refuses missing and unsupported media types", async () => {
    const missing = dependencies(() => new Response("body"));
    await expect(
      run({ url: "https://public.example/" }, missing),
    ).rejects.toThrow("media type is missing");

    const pdf = dependencies(
      () =>
        new Response("pdf", { headers: { "content-type": "application/pdf" } }),
    );
    await expect(
      run({ url: "https://public.example/file.pdf" }, pdf),
    ).rejects.toThrow('media type "application/pdf" is not allowed');

    const malformed = dependencies(
      () => new Response("body", { headers: { "content-type": "text/" } }),
    );
    await expect(
      run({ url: "https://public.example/bad" }, malformed),
    ).rejects.toThrow('media type "text/" is not allowed');
  });

  test("decodes the declared charset and falls back on an unknown label", async () => {
    const latin1 = dependencies(
      () =>
        new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), {
          headers: { "content-type": "text/plain; charset=iso-8859-1" },
        }),
    );
    expect(await run({ url: "https://public.example/" }, latin1)).toBe("café");

    const unknown = dependencies(
      () =>
        new Response("snowman: ☃", {
          headers: { "content-type": "application/json; charset=no-such" },
        }),
    );
    expect(await run({ url: "https://public.example/" }, unknown)).toBe(
      "snowman: ☃",
    );
  });

  test("names a non-success HTTP status", async () => {
    const deps = dependencies(() => textResponse("missing", { status: 404 }));
    await expect(
      run({ url: "https://public.example/missing" }, deps),
    ).rejects.toThrow("HTTP status 404");
  });
});

describe("fetch extraction and slicing", () => {
  test("extracts the saved HTML fixture with skipped and structured elements", async () => {
    const fixture = await Bun.file(
      new URL("../../fixtures/tools/page.html", import.meta.url),
    ).text();
    const text = await extractHtml(
      fixture,
      new URL("https://example.com/base"),
    );
    expect(text.split("\n", 1)[0]).toBe("Fixture title");
    expect(text).toContain("# First heading");
    expect(text).toContain("## Second");
    expect(text).toContain("###### Sixth");
    expect(text).toContain(
      "A paragraph with collapsed whitespace and the next page (https://example.com/next).",
    );
    expect(text).toContain("- One\n- Two");
    expect(text).toContain("LeftRight");
    expect(text).toContain("Before\nAfter\nRule");
    expect(text).toContain("  exact\n    pre   spacing\n\n\nkept");
    expect(text).toContain("mail link");
    for (const hidden of [
      "SCRIPT MUST NOT APPEAR",
      "NESTED SCRIPT MUST NOT APPEAR",
      "HEADER MUST NOT APPEAR",
      "NAV MUST NOT APPEAR",
      "NOSCRIPT MUST NOT APPEAR",
      "IFRAME MUST NOT APPEAR",
      "SVG MUST NOT APPEAR",
      "TEMPLATE MUST NOT APPEAR",
      "FOOTER MUST NOT APPEAR",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("extracts a fetched HTML page through fetchText", async () => {
    const deps = dependencies(
      () =>
        new Response("<title>T</title><p>Body text</p>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    expect(await run({ url: "https://public.example/" }, deps)).toBe(
      "T\n\nBody text",
    );
  });

  test("slices in UTF-16 code units and appends the exact continuation hint", () => {
    expect(sliceContent("a😀bcdef", 1, 3)).toBe(
      "😀b\n\n<error>Content truncated. Call the webfetch tool with a start_index of 4 to get more content.</error>",
    );
    expect(sliceContent("abcd", 0, 4)).toBe("abcd");
    expect(sliceContent("abcd", 4, 4)).toBe(
      "<error>No more content available.</error>",
    );
  });
});

describe("fetch deadline", () => {
  test("times out a fetch that never resolves", async () => {
    const ctx: ToolContext = {
      signal: new AbortController().signal,
      now: () => 0,
      budget: { fetches: 0, searches: 0, visualBytes: 0 },
      caps: { ...TOOL_CAPS, fetchDeadlineMs: 20 },
    };
    const deps: FetchDependencies = {
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        })) as typeof fetch,
    };
    await expect(
      fetchText({ url: "https://public.example/" }, ctx, "vtest", deps),
    ).rejects.toThrow("fetch timed out after 0.02 seconds");
  });
});

describe("webfetch tool wrapper", () => {
  test("makeWebfetchTool carries the name, schema and version", async () => {
    const deps = dependencies((_url, init) => {
      expect(new Headers(init.headers).get("user-agent")).toBe("1ctx/v9");
      return textResponse("page");
    });
    const tool = makeWebfetchTool("v9", deps);
    expect(tool.name).toBe("webfetch");
    expect(await tool.run({ url: "https://public.example/" }, context())).toBe(
      "page",
    );
  });
});
