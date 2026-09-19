// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { withUserAgent } from "../../../src/server/lib/fetcher.ts";

function spy() {
  const seen: { input: unknown; init?: RequestInit }[] = [];
  const base = Object.assign(
    async (input: unknown, init?: RequestInit) => {
      seen.push({ input, init });
      return new Response("ok");
    },
    { preconnect() {} },
  ) as typeof fetch;
  return { seen, base };
}

describe("the named fetcher", () => {
  test("a request without a user agent names the binary", async () => {
    const { seen, base } = spy();
    const fetcher = withUserAgent(base, "v1.2.3");
    await fetcher("http://provider.test/models");
    await fetcher("http://provider.test/chat", {
      method: "POST",
      headers: { authorization: "Bearer k" },
    });
    await fetcher("http://provider.test/mcp", {
      headers: new Headers({ accept: "text/event-stream" }),
    });
    expect(new Headers(seen[0]?.init?.headers).get("user-agent")).toBe(
      "1ctx/v1.2.3",
    );
    // a record stays a record, with what the caller set
    expect(seen[1]?.init?.headers).toEqual({
      authorization: "Bearer k",
      "user-agent": "1ctx/v1.2.3",
    });
    expect(seen[1]?.init?.method).toBe("POST");
    const third = new Headers(seen[2]?.init?.headers);
    expect(third.get("user-agent")).toBe("1ctx/v1.2.3");
    expect(third.get("accept")).toBe("text/event-stream");
  });

  test("a caller's own user agent is kept, in any case", async () => {
    const { seen, base } = spy();
    const fetcher = withUserAgent(base, "v1.2.3");
    const init = { headers: { "User-Agent": "other/1" } };
    await fetcher("http://site.test/", init);
    expect(seen[0]?.init).toBe(init);
  });

  test("a Request's own headers are carried", async () => {
    const { seen, base } = spy();
    await withUserAgent(
      base,
      "v1",
    )(new Request("http://site.test/", { headers: { "x-one": "1" } }));
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get("x-one")).toBe("1");
    expect(headers.get("user-agent")).toBe("1ctx/v1");
  });
});
