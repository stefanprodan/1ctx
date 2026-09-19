// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  MAX_WEB_DOMAINS,
  originAllowed,
  parseDomains,
  urlPrefixes,
} from "../../src/shared/web.ts";

describe("web access domains", () => {
  test("keeps plain hosts, sorted, deduped, lowercased, blanks dropped", () => {
    expect(
      parseDomains(["GitHub.com", "", "  api.github.com ", "github.com."]),
    ).toEqual({ ok: true, domains: ["api.github.com", "github.com"] });
  });

  test("takes an IDN as its ASCII form and an IP literal as a host", () => {
    expect(parseDomains(["bücher.example", "10.0.0.7", "[::1]"])).toEqual({
      ok: true,
      domains: ["10.0.0.7", "[::1]", "xn--bcher-kva.example"],
    });
  });

  for (const line of [
    "*",
    "*.example.com",
    "https://example.com",
    "example.com/docs",
    "example.com:8443",
    "example.com:80",
    "[::1]:80",
    "[::1]:",
    "user@example.com",
    "exa mple.com",
    "-bad.example.com",
    "example..com",
  ]) {
    test(`refuses ${line} and names its line`, () => {
      const result = parseDomains(["ok.example.com", line]);
      expect(result).toMatchObject({ ok: false, line: 2, value: line });
    });
  }

  test("refuses more hosts than the cap", () => {
    const lines = Array.from(
      { length: MAX_WEB_DOMAINS + 1 },
      (_, i) => `h${i}.example.com`,
    );
    expect(parseDomains(lines).ok).toBe(false);
  });

  test("an empty list parses, the mode decides whether it may be empty", () => {
    expect(parseDomains(["", " "])).toEqual({ ok: true, domains: [] });
  });
});

describe("originAllowed", () => {
  const domains = ["docs.example.com", "xn--bcher-kva.example", "10.0.0.7"];
  const cases: [string, boolean][] = [
    ["https://docs.example.com/a?b=c", true],
    ["http://docs.example.com/", true],
    ["https://DOCS.example.com/", true],
    ["https://bücher.example/", true],
    ["http://10.0.0.7/x", true],
    ["https://docs.example.com:443/", true],
    ["https://docs.example.com:8443/", false],
    ["https://docs.example.com./", false],
    ["https://example.com/", false],
    ["https://a.docs.example.com/", false],
    ["https://docs.example.com.evil.test/", false],
    ["ftp://docs.example.com/", false],
    ["file:///etc/hosts", false],
  ];
  for (const [url, allowed] of cases) {
    test(`${url} is ${allowed ? "allowed" : "refused"}`, () => {
      expect(originAllowed(new URL(url), domains)).toBe(allowed);
    });
  }

  test("an empty list allows nothing", () => {
    expect(originAllowed(new URL("https://docs.example.com/"), [])).toBe(false);
  });
});

test("urlPrefixes gives both schemes per host", () => {
  expect(urlPrefixes(["a.test", "b.test"])).toEqual([
    "https://a.test",
    "http://a.test",
    "https://b.test",
    "http://b.test",
  ]);
});
