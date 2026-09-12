// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The router on its own: matching, the origin rule, malformed paths, a
// renewed cookie riding back, and the conflict check at construction.

import { describe, expect, test } from "bun:test";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import { json, type RouteDescriptor } from "../../../src/server/lib/http.ts";
import {
  conflicts,
  router,
  sameOrigin,
} from "../../../src/server/web/router.ts";
import { clientAddress } from "../../../src/server/web/serve.ts";

const echo: RouteDescriptor = {
  method: "GET",
  path: "/api/things/:id",
  policy: "public",
  handle: (_req, ctx) => json({ id: ctx.params.id }),
};

const nobody = () => ({ principal: null, setCookie: null });

describe("conflicts", () => {
  test("a parameter opposite a literal is an overlap", () => {
    const a = { ...echo, path: "/api/things/new" };
    expect(conflicts([echo, a])).toEqual([
      "GET /api/things/:id overlaps /api/things/new",
    ]);
    expect(conflicts([echo, { ...a, method: "POST" }])).toEqual([]);
    expect(conflicts([echo, { ...echo, path: "/api/things" }])).toEqual([]);
  });

  test("the router refuses to start on one", () => {
    expect(() =>
      router({ routes: [echo, echo], resolve: nobody, trustProxy: false }),
    ).toThrow("overlaps");
  });
});

describe("sameOrigin", () => {
  const url = new URL("http://app.test/api/x");
  const req = (headers: Record<string, string>) =>
    new Request(url, { method: "POST", headers });

  test("same host and scheme", () => {
    expect(sameOrigin(req({ origin: "http://app.test" }), url, false)).toBe(
      true,
    );
  });

  test("another host, or a plaintext page of a TLS host, is refused", () => {
    expect(sameOrigin(req({ origin: "http://evil.test" }), url, false)).toBe(
      false,
    );
    const tls = new URL("https://app.test/api/x");
    expect(sameOrigin(req({ origin: "http://app.test" }), tls, false)).toBe(
      false,
    );
  });

  test("the forwarded scheme counts only with a trusted proxy", () => {
    const r = req({ origin: "https://app.test", "x-forwarded-proto": "https" });
    // https is never a downgrade, so it passes with or without trust
    expect(sameOrigin(r, url, false)).toBe(true);
    expect(sameOrigin(r, url, true)).toBe(true);
    const plain = req({
      origin: "http://app.test",
      "x-forwarded-proto": "https",
    });
    expect(sameOrigin(plain, url, false)).toBe(true);
    expect(sameOrigin(plain, url, true)).toBe(false);
  });

  test("a client-sent prefix before the proxy's value is ignored", () => {
    // the proxy appends; whatever the client put first does not count
    const spoofed = req({
      origin: "http://app.test",
      "x-forwarded-proto": "http, https",
    });
    expect(sameOrigin(spoofed, url, true)).toBe(false);
  });

  test("a garbage origin is refused", () => {
    expect(sameOrigin(req({ origin: "not a url" }), url, false)).toBe(false);
  });
});

describe("clientAddress", () => {
  test("is the socket's unless a proxy is trusted", () => {
    const r = new Request("http://x", {
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
    });
    expect(clientAddress(r, "9.9.9.9", false)).toBe("9.9.9.9");
    expect(clientAddress(r, "9.9.9.9", true)).toBe("2.2.2.2");
    const empty = new Request("http://x", {
      headers: { "x-forwarded-for": "" },
    });
    expect(clientAddress(empty, "9.9.9.9", true)).toBe("9.9.9.9");
    expect(clientAddress(new Request("http://x"), "9.9.9.9", true)).toBe(
      "9.9.9.9",
    );
    expect(clientAddress(new Request("http://x"), null, false)).toBe("unknown");
  });
});

describe("router", () => {
  const handle = router({ routes: [echo], resolve: nobody, trustProxy: false });
  const get = (path: string) => handle(new Request(`http://x${path}`), "a");

  test("decodes a parameter and refuses a malformed one", async () => {
    expect(await (await get("/api/things/a%20b")).json()).toEqual({
      id: "a b",
    });
    const bad = await get("/api/things/%E0%A4%A");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "malformed id in path" });
  });

  test("404 for no path, 405 for the wrong method", async () => {
    expect((await get("/api/nothing")).status).toBe(404);
    const res = await handle(
      new Request("http://x/api/things/1", {
        method: "POST",
        headers: { origin: "http://x" },
      }),
      "a",
    );
    expect(res.status).toBe(405);
  });

  test("a renewed cookie rides back unless the handler set one", async () => {
    const renew = router({
      routes: [
        echo,
        {
          ...echo,
          path: "/api/own",
          handle: () => json({}, 200, { "set-cookie": "login=; Max-Age=0" }),
        },
      ],
      resolve: () => ({ principal: null, setCookie: "login=t; Max-Age=9" }),
      trustProxy: false,
    });
    const a = await renew(new Request("http://x/api/things/1"), "a");
    expect(a.headers.get("set-cookie")).toBe("login=t; Max-Age=9");
    const b = await renew(new Request("http://x/api/own"), "a");
    expect(b.headers.get("set-cookie")).toBe("login=; Max-Age=0");
  });

  test("a renewed cookie rides back on a denial and on an error too", async () => {
    const renew = router({
      routes: [
        { ...echo, path: "/api/admin", policy: "admin" },
        {
          ...echo,
          path: "/api/boom",
          handle: () => {
            throw new BadRequest("no");
          },
        },
      ],
      resolve: () => ({
        principal: { userId: "u", name: "u", role: "member", loginId: "l" },
        setCookie: "login=t; Max-Age=9",
      }),
      trustProxy: false,
    });
    const denied = await renew(new Request("http://x/api/admin"), "a");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("set-cookie")).toBe("login=t; Max-Age=9");
    const failed = await renew(new Request("http://x/api/boom"), "a");
    expect(failed.status).toBe(400);
    expect(failed.headers.get("set-cookie")).toBe("login=t; Max-Age=9");
  });
});
