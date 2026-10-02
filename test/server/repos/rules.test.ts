// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  effectiveIgnore,
  type IgnoreRules,
  ignored,
  ignoreKey,
  parseIgnore,
} from "../../../src/server/repos/rules.ts";
import { DEFAULT_REPO_IGNORE } from "../../../src/shared/contracts/repo.ts";
import fixture from "../../fixtures/repos/ignore-cases.json";

function rules(text: string): IgnoreRules {
  const parsed = parseIgnore(text);
  if (!parsed.ok) throw new Error(`${parsed.line}: ${parsed.reason}`);
  return parsed.rules;
}

describe("ignored matches git check-ignore", () => {
  for (const c of fixture.cases) {
    test(c.name, () => {
      const r = rules(c.ignore);
      const got = fixture.tree
        .filter((entry) => ignored(r, entry.path, entry.dir))
        .map((entry) => entry.path)
        .sort();
      expect(got).toEqual(c.ignored);
    });
  }
});

test("the default list is what an empty text applies", () => {
  expect(DEFAULT_REPO_IGNORE).toEqual([
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.ico",
    "*.webp",
    "*.bmp",
    "*.tiff",
    "*.psd",
    "*.mp4",
    "*.mov",
    "*.webm",
    "*.avi",
    "*.mkv",
    "*.mp3",
    "*.wav",
    "*.ogg",
    "*.flac",
    "*.woff",
    "*.woff2",
    "*.ttf",
    "*.otf",
    "*.eot",
    "*.zip",
    "*.jar",
    "*.war",
    "*.7z",
    "*.rar",
    "*.exe",
    "*.dll",
    "*.so",
    "*.dylib",
    "*.a",
    "*.o",
    "*.class",
    "*.pyc",
    "*.wasm",
    "*.pdf",
    "*.sqlite",
    "*.db",
  ]);
  // archives bash's tar and zcat open stay in the tree
  for (const kept of ["*.tar.gz", "*.tgz", "*.gz", "*.tar"]) {
    expect(DEFAULT_REPO_IGNORE).not.toContain(kept);
  }
  expect(effectiveIgnore("")).toBe(`${DEFAULT_REPO_IGNORE.join("\n")}\n`);
  expect(effectiveIgnore("  \n\n")).toBe(effectiveIgnore(""));
  expect(effectiveIgnore("*.md\n")).toBe("*.md\n");
  const recorded = fixture.cases.find((c) => c.name === "default list");
  expect(recorded?.ignore).toBe(effectiveIgnore(""));
});

test("the key names the effective rules", () => {
  expect(ignoreKey("")).toMatch(/^[0-9a-f]{12}$/);
  expect(ignoreKey("")).toBe(ignoreKey(effectiveIgnore("")));
  expect(ignoreKey("*.md")).toBe(ignoreKey("*.md\r\n\n"));
  expect(ignoreKey("*.md")).not.toBe(ignoreKey("*.txt"));
  expect(ignoreKey("*.md")).not.toBe(ignoreKey(""));
});

test("a line git never matches is refused by its number", () => {
  const cases: [string, number, string][] = [
    ["*.md\n[abc\n", 2, "unclosed ["],
    ["[]\n", 1, "unclosed ["],
    ["[!]\n", 1, "unclosed ["],
    ["a[\\\n", 1, "unclosed ["],
    ["[a-\\\n", 1, "unclosed ["],
    ["[[:alpha:]\n", 1, "unclosed ["],
    ["[[:alpha\n", 1, "unclosed ["],
    ["x\n\n# c\n[[:word:]]\n", 4, "unknown class [:word:]"],
    ["[[:constructor:]]\n", 1, "unknown class [:constructor:]"],
    ["foo\\\n", 1, "ends in a backslash"],
    ["!\\\n", 1, "ends in a backslash"],
  ];
  for (const [text, line, reason] of cases) {
    expect(parseIgnore(text)).toEqual({ ok: false, line, reason });
  }
});

test("patterns git accepts are accepted", () => {
  for (const text of [
    "[]]",
    "[!]]",
    "[a-]",
    "[[:a]",
    "[[]",
    "[\\]]",
    "\\[",
    "a\\ ",
    "a\\\\",
    "!",
    "/",
    "**/**/x",
    "\uFEFF*.md",
  ]) {
    expect(parseIgnore(text).ok).toBe(true);
  }
});

test("a byte order mark is not part of the first pattern", () => {
  expect(ignored(rules("\uFEFF*.md"), "a.md", false)).toBe(true);
});

test("the caps refuse a long text", () => {
  const lines = (n: number) => `${Array(n).fill("x").join("\n")}\n`;
  expect(parseIgnore(lines(200)).ok).toBe(true);
  expect(parseIgnore(lines(201))).toEqual({
    ok: false,
    line: 201,
    reason: "more than 200 lines",
  });
  expect(parseIgnore(`${"a".repeat(8192)}`).ok).toBe(true);
  expect(parseIgnore(`${"a".repeat(8193)}`)).toEqual({
    ok: false,
    line: 0,
    reason: "longer than 8 KiB",
  });
  expect(parseIgnore("é".repeat(4097))).toEqual({
    ok: false,
    line: 0,
    reason: "longer than 8 KiB",
  });
});

test("the answer depends on the path alone", () => {
  const r = rules("charts/\n!charts/app/Chart.yaml\n");
  const paths = ["charts/app/Chart.yaml", "charts", "charts/app"];
  const first = paths.map((p) => ignored(r, p, !p.endsWith(".yaml")));
  const again = paths
    .toReversed()
    .map((p) => ignored(r, p, !p.endsWith(".yaml")))
    .toReversed();
  expect(first).toEqual([true, true, true]);
  expect(again).toEqual(first);
});

test("a deep path is answered without recursion per folder", () => {
  const r = rules("x/\n");
  const deep = Array(50_000).fill("a");
  expect(ignored(r, deep.join("/"), false)).toBe(false);
  deep[20_000] = "x";
  expect(ignored(r, deep.join("/"), false)).toBe(true);
});

test("a folder answered once keeps its answer", () => {
  const r = rules("/*\n!/charts/\n");
  expect(ignored(r, "charts/app/a.yaml", false)).toBe(false);
  expect(ignored(r, "src/a/b.go", false)).toBe(true);
  expect(ignored(r, "charts/app/b.yaml", false)).toBe(false);
  expect(ignored(r, "src/a/c.go", false)).toBe(true);
});

test("many stars on a long name stay fast", () => {
  // each name holds the patterns' literals, so only the full match refuses it
  const r = rules(`${"*a".repeat(60)}*ab*b\n${"**/a/".repeat(7)}b/**/b\n`);
  const name = `${"a".repeat(4000)}b`;
  const deep = `${Array(200).fill("a").join("/")}/b`;
  const start = performance.now();
  expect(ignored(r, name, false)).toBe(false);
  expect(ignored(r, deep, false)).toBe(false);
  expect(performance.now() - start).toBeLessThan(500);
});
