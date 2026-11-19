// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  foldDefaults,
  hostWords,
  MAX_SANDBOX_HOSTS,
  parseSandboxHosts,
  SANDBOX_DEFAULT_HOSTS,
  sandboxNet,
} from "../../src/shared/sandbox-net.ts";

const hosts = (lines: string[]) => {
  const parsed = parseSandboxHosts(lines);
  if (!parsed.ok) throw new Error(`${parsed.line}: ${parsed.error}`);
  return parsed.hosts;
};

describe("the sandbox's hosts", () => {
  test("keeps hosts and wildcards, sorted, deduped, lowercased, blanks dropped", () => {
    expect(
      hosts([
        "PyPI.org",
        "",
        "  *.GitHubUserContent.com ",
        "pypi.org.",
        "**.example.com",
        "*-api.example.com",
        "api.*.example.com",
        "10.0.0.7",
      ]),
    ).toEqual([
      "**.example.com",
      "*-api.example.com",
      "*.githubusercontent.com",
      "10.0.0.7",
      "api.*.example.com",
      "pypi.org",
    ]);
  });

  test("takes an IDN as its ASCII form, in a wildcard too", () => {
    expect(hosts(["bücher.example", "*.bücher.example"])).toEqual([
      "*.xn--bcher-kva.example",
      "xn--bcher-kva.example",
    ]);
  });

  test("refuses what OpenShell would not take, by line", () => {
    for (const [line, error] of [
      ["*", "needs three labels as a wildcard"],
      ["*.com", "needs three labels as a wildcard"],
      ["**.com", "needs three labels as a wildcard"],
      ["*.example.com:443", "is not a wildcard the sandbox takes"],
      ["a**.example.com", "is not a wildcard the sandbox takes"],
      ["*a*.example.com", "is not a wildcard the sandbox takes"],
      ["api.**.example.com", "is not a wildcard the sandbox takes"],
      ["api.a*.example.com", "is not a wildcard the sandbox takes"],
      ["*..example.com", "is not a wildcard the sandbox takes"],
      ["*.bad_label.com", "is not a wildcard the sandbox takes"],
      ["-*.example.com", "is not a wildcard the sandbox takes"],
      ["*-.example.com", "is not a wildcard the sandbox takes"],
      ["a-*-.example.com", "is not a wildcard the sandbox takes"],
      // the parser's own stand-in for a `*` label is never read as one
      ["*.x--wildcard.com", "is not a wildcard the sandbox takes"],
      ["*.ｘ--wildcard.com", "is not a wildcard the sandbox takes"],
      ["https://pypi.org", "is not a host name"],
      ["pypi.org/simple", "is not a host name"],
      ["pypi.org:443", "is not a host name"],
      ["[::1]", "is not a host name"],
      ["user@pypi.org", "is not a host name"],
      ["a b.org", "is not a host name"],
    ] as const) {
      expect(parseSandboxHosts(["ok.example.com", ` ${line}`]), line).toEqual({
        ok: false,
        line: 2,
        value: line,
        error,
      });
    }
  });

  test("caps the list", () => {
    const many = Array.from(
      { length: MAX_SANDBOX_HOSTS + 1 },
      (_, i) => `h${i}.test`,
    );
    expect(parseSandboxHosts(many)).toMatchObject({
      ok: false,
      error: `at most ${MAX_SANDBOX_HOSTS} hosts`,
    });
    expect(hosts(many.slice(1))).toHaveLength(MAX_SANDBOX_HOSTS);
  });

  test("the defaults parse, sorted as a save stores them, well under the cap", () => {
    expect(hosts([...SANDBOX_DEFAULT_HOSTS])).toEqual([
      ...SANDBOX_DEFAULT_HOSTS,
    ]);
    expect(SANDBOX_DEFAULT_HOSTS.length).toBeLessThan(MAX_SANDBOX_HOSTS / 4);
    expect(SANDBOX_DEFAULT_HOSTS).toContain("*.githubusercontent.com");
  });

  test("a wildcard within the first label keeps inner hyphens", () => {
    expect(
      hosts(["*-api.example.com", "api-*.example.com", "a*b.example.com"]),
    ).toEqual(["*-api.example.com", "a*b.example.com", "api-*.example.com"]);
  });

  test("the defaults fold to null in any order, any other list stays", () => {
    expect(foldDefaults([...SANDBOX_DEFAULT_HOSTS].reverse())).toBeNull();
    expect(foldDefaults(SANDBOX_DEFAULT_HOSTS.slice(1))).toEqual(
      SANDBOX_DEFAULT_HOSTS.slice(1),
    );
    expect(foldDefaults(["a.test"])).toEqual(["a.test"]);
  });

  test("null hosts are the defaults", () => {
    expect(sandboxNet({ network: "hosts", hosts: null })).toEqual({
      mode: "hosts",
      hosts: SANDBOX_DEFAULT_HOSTS,
    });
    expect(sandboxNet({ network: "off", hosts: ["a.test"] })).toEqual({
      mode: "off",
      hosts: ["a.test"],
    });
  });

  test("names ten, then how many more", () => {
    const many = Array.from({ length: 12 }, (_, i) => `h${i + 10}.test`);
    expect(hostWords(many)).toBe(`${many.slice(0, 10).join(", ")} and 2 more`);
    expect(hostWords(["a.test"])).toBe("a.test");
  });
});
