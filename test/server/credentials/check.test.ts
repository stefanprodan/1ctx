// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  checkHeaderName,
  checkTemplate,
  headerValue,
  httpKeys,
  isUsableKey,
  normalizePrefix,
  prefixesOverlap,
  readKey,
} from "../../../src/server/credentials/index.ts";
import {
  KEY_BYTES,
  MAX_PREFIX,
  MAX_TEMPLATE,
} from "../../../src/shared/contracts/credential.ts";

const prefix = (value: unknown) => normalizePrefix(value);

describe("the prefix", () => {
  test("is stored as the parsed origin and path", () => {
    for (const [given, stored] of [
      ["https://api.example.test/v1/", "https://api.example.test/v1/"],
      ["https://API.Example.test:443/v1", "https://api.example.test/v1"],
      ["https://api.example.test", "https://api.example.test/"],
      ["https://api.example.test./repos/", "https://api.example.test/repos/"],
      ["https://api.example.test:8443/x", "https://api.example.test:8443/x"],
    ]) {
      expect(prefix(given)).toEqual({ ok: true, value: stored });
    }
  });

  test("refuses anything but a plain https URL", () => {
    for (const [given, words] of [
      ["http://api.example.test/", "must be https"],
      ["ftp://api.example.test/", "must be https"],
      ["https://user@api.example.test/", "user or a password"],
      ["https://user:pw@api.example.test/", "user or a password"],
      ["https://api.example.test/?q=1", "query or a fragment"],
      ["https://api.example.test/?", "query or a fragment"],
      ["https://api.example.test/#top", "query or a fragment"],
      ["https://api.example.test/#", "query or a fragment"],
      ["https://./", "must name a host"],
      ["https://api.example.test/a%2fb/", "not a usable URL prefix"],
      ["not a url", "must be a URL"],
      ["", `at most ${MAX_PREFIX}`],
      [`https://api.example.test/${"a".repeat(MAX_PREFIX)}`, `at most`],
      [7, "must be a URL"],
    ] as const) {
      const result = prefix(given);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(words);
    }
  });

  test("overlaps when either reaches the other, either way round", () => {
    const pairs: [string, string, boolean][] = [
      ["https://a.test/", "https://a.test/v1/", true],
      ["https://a.test/v1/", "https://a.test/v1/repos/", true],
      ["https://a.test/v1", "https://a.test/v1/x", true],
      ["https://a.test/v1/", "https://a.test/v1", true],
      ["https://a.test/v1/", "https://a.test/v1/", true],
      ["https://a.test/v1", "https://a.test/v10", false],
      ["https://a.test/v1/", "https://a.test/v2/", false],
      ["https://a.test/", "https://b.test/", false],
      ["https://a.test/", "https://a.test:8443/", false],
    ];
    for (const [a, b, overlap] of pairs) {
      expect(prefixesOverlap(a, b)).toBe(overlap);
      expect(prefixesOverlap(b, a)).toBe(overlap);
    }
  });
});

describe("the header", () => {
  test("is a token the transport does not own", () => {
    for (const name of ["Authorization", "X-Api-Key", "x_token", "a.b"]) {
      expect(checkHeaderName(name)).toEqual({ ok: true, value: name });
    }
    for (const name of [
      "",
      "X Api",
      "X:Api",
      "Xé",
      "a".repeat(129),
      null,
      "Host",
      "CONTENT-LENGTH",
      "Transfer-Encoding",
      "connection",
      "Keep-Alive",
      "TE",
      "trailer",
      "Upgrade",
      "Proxy-Authorization",
      "proxy-anything",
    ]) {
      expect(checkHeaderName(name).ok).toBe(false);
    }
  });

  test("its template holds the key once in printable ASCII", () => {
    for (const value of ["Bearer {key}", "{key}", "token={key};v=1"]) {
      expect(checkTemplate(value)).toEqual({ ok: true, value });
    }
    for (const value of [
      "Bearer",
      "",
      "{key} {key}",
      "{KEY}",
      "Bearer {key}\r\nX-Other: 1",
      "Bearer\t{key}",
      "Bearer {key}\u0000",
      "Bearer {key}\u007f",
      "Bearer {key} é",
      `{key}${"a".repeat(MAX_TEMPLATE)}`,
      null,
    ]) {
      expect(checkTemplate(value).ok).toBe(false);
    }
    expect(headerValue("Bearer {key}", "$&abc")).toBe("Bearer $&abc");
  });
});

describe("the key", () => {
  test("is 16 to 4096 visible ASCII characters", () => {
    expect(isUsableKey("k".repeat(KEY_BYTES.min))).toBe(true);
    expect(isUsableKey("!~".repeat(KEY_BYTES.max / 2))).toBe(true);
    for (const value of [
      "k".repeat(KEY_BYTES.min - 1),
      "k".repeat(KEY_BYTES.max + 1),
      `${"k".repeat(16)} space`,
      `${"k".repeat(16)}é`,
      `${"k".repeat(16)}\t`,
      "",
    ]) {
      expect(isUsableKey(value)).toBe(false);
    }
  });

  test("is read at the moment, missing, unusable or ok", () => {
    const files: Record<string, string | null> = {
      "http-good": "0123456789abcdef",
      "http-short": "short",
      // listed, and the port answered null: empty or past the size cap
      "http-empty": null,
    };
    const keys = httpKeys({
      secret: (kind, name) => (kind === "http-" ? (files[name] ?? null) : "v"),
      secretNames: () => Object.keys(files),
    });
    expect(readKey(keys, "http-good")).toEqual({
      ok: true,
      key: "0123456789abcdef",
    });
    expect(readKey(keys, "http-short")).toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(readKey(keys, "http-empty")).toEqual({
      ok: false,
      reason: "unusable",
    });
    expect(readKey(keys, "http-gone")).toEqual({
      ok: false,
      reason: "missing",
    });
    // a scrub list takes only a key that could be sent
    expect(keys.scrubbed("http-", "http-good")).toBe("0123456789abcdef");
    expect(keys.scrubbed("http-", "http-short")).toBeNull();
    expect(keys.scrubbed("mcp-", "mcp-any")).toBe("v");
  });
});
