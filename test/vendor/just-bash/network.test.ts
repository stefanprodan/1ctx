// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test } from "bun:test";
import { createSecureFetch } from "just-bash";

describe("deprecated request-owned DNS connector", () => {
  test("rejects a custom DNS resolver before opening a request", () => {
    const resolve = mock(async () => []);
    expect(() =>
      createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _dnsResolve: resolve,
      }),
    ).toThrow("_dnsResolve is no longer supported");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("rejects a custom connection owner before opening a request", () => {
    const connect = mock(async () => {
      throw new Error("must not open a connection");
    });
    expect(() =>
      createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        _createConnectionOwner: connect,
      }),
    ).toThrow("_createConnectionOwner is no longer supported");
    expect(connect).not.toHaveBeenCalled();
  });
});

test.serial(
  "redirect userinfo reaches the ambient fetch unchanged",
  async () => {
    const original = globalThis.fetch;
    const target = "http://user:pass@127.0.0.1/end";
    const seen: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        seen.push(url);
        return url === target
          ? new Response("done")
          : new Response(null, { status: 302, headers: { location: target } });
      },
      { preconnect: original.preconnect },
    );
    try {
      const fetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: false,
      });
      await fetch("http://127.0.0.1/start", { followRedirects: true });
      expect(seen).toEqual(["http://127.0.0.1/start", target]);
    } finally {
      globalThis.fetch = original;
    }
  },
);
