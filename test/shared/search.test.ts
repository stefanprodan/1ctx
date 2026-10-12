// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  bestLines,
  creditedCount,
  holdsAll,
  matchLines,
  searchTerms,
  termRanges,
} from "../../src/shared/search.ts";

describe("searchTerms", () => {
  test.each([
    ["alpha", ["alpha"]],
    ["  Alpha   BETA ", ["alpha", "beta"]],
    ['"read on" files', ["read on", "files"]],
    ['files "Read  On"', ["files", "read  on"]],
    ['" read on "', ["read on"]],
    ['ab"cd ef"', ["ab", "cd ef"]],
    ["a\tb", ["a", "b"]],
    ["run run RUN", ["run"]],
    // an unbalanced quote makes the rest one phrase
    ['files "read on', ["files", "read on"]],
    ['"', []],
    ['""', []],
    ['" "', []],
    ["", []],
    ["   ", []],
  ])("splits %j", (q, terms) => {
    expect(searchTerms(q)).toEqual(terms);
  });
});

// a text's hit as knowledge search builds it, null when it misses a word
const matchText = (text: string, terms: readonly string[]) =>
  holdsAll(text, terms) ? bestLines(text, terms) : null;

describe("a text's hit", () => {
  test("words on different lines of one text match", () => {
    const text = "the plan\nsome notes\nexternal tasks here\nend";
    expect(matchText(text, searchTerms("plan external tasks"))).toEqual({
      count: 2,
      lines: [
        { line: 1, text: "the plan", cutStart: false, cutEnd: false },
        {
          line: 3,
          text: "external tasks here",
          cutStart: false,
          cutEnd: false,
        },
      ],
    });
  });

  test("a text missing one word does not match", () => {
    const text = "the plan\nexternal work";
    expect(matchText(text, searchTerms("plan external tasks"))).toBeNull();
    expect(holdsAll(text, searchTerms("plan external tasks"))).toBe(false);
    expect(holdsAll(text, searchTerms("PLAN external"))).toBe(true);
  });

  test("a quoted phrase matches only as written", () => {
    const terms = searchTerms('"read on"');
    expect(matchText("read the rest, then on", terms)).toBeNull();
    expect(matchText("then Read On here", terms)?.count).toBe(1);
    expect(matchText("read\non", terms)).toBeNull();
  });

  test("folds non-ASCII case and marks the source units", () => {
    const terms = searchTerms("ÉTÉ straße");
    const line = "İİ Été and STRASSE no, Straße yes";
    expect(holdsAll(line, terms)).toBe(true);
    const hit = matchText(line, terms)!.lines[0]!;
    expect(hit.text).toBe(line);
    const ranges = termRanges(line, terms);
    expect(ranges.map((r) => line.slice(r.from, r.to))).toEqual([
      "Été",
      "Straße",
    ]);
  });

  test("a term inside another marks once and needs both", () => {
    const terms = searchTerms("run running");
    expect(matchText("running late", terms)?.count).toBe(1);
    expect(matchText("run fast", terms)).toBeNull();
    const line = "a Running start, run";
    expect(
      termRanges(line, terms).map((r) => line.slice(r.from, r.to)),
    ).toEqual(["Running", "run"]);
  });

  test("hit lines hold any word, counted and capped", () => {
    const text = "alpha\nbeta\nnone\nalpha beta\nbeta\nalpha";
    const found = matchLines(text, searchTerms("alpha beta"));
    expect(found.count).toBe(5);
    expect(found.lines.map((line) => line.line)).toEqual([1, 2, 4]);
  });

  test("a long line is cut round its first match", () => {
    const line = `${"a ".repeat(150)}needle ${"b ".repeat(150)}`;
    const [hit] = matchText(line, searchTerms("needle b"))!.lines;
    expect(hit!.cutStart).toBe(true);
    expect(hit!.text).toContain("needle");
  });
});

describe("creditedCount", () => {
  const count = (text: string, q: string) =>
    creditedCount(text.toLowerCase(), searchTerms(q)[0]!);

  test.each([
    ["a claim", "claim", 1],
    ["two claims", "claim", 1],
    ["claimed, claiming, claimer, claimers", "claim", 4],
    ["claimUploads", "claim", 0],
    ["reclaim", "claim", 0],
    ["claimant", "claim", 0],
    ["claim_1 and claim2", "claim", 2],
    ["FTS5 tables", "fts", 1],
    ["utf8", "utf", 1],
    ["sha256", "sha", 1],
    ["sha256", "256", 1],
    ["fts5", "5", 1],
    ["ts5x", "ts", 1],
    ["v2claim", "claim", 1],
    ["x2560", "256", 0],
    ["release-notes", "release", 1],
    ["pre-release", "release", 1],
    ["prerelease", "release", 0],
    ["releasing", "release", 1],
    ["releasings", "release", 0],
    ["released, releases", "release", 2],
    ["writing it", "write", 1],
    ["releasing", "release", 1],
    ["a thing", "the", 0],
    ["a wing", "we", 0],
    ["a ring", "re", 0],
    ["e\u0301tude", "tude", 0],
    ["e\u0301tude", "e\u0301tude", 1],
    ["docs/full-text-search.md", "search", 1],
    ["search.ts", ".ts", 1],
    ["search.tsx", ".ts", 0],
    ["a.ts.map", ".ts", 1],
    ["-- and --", "--", 2],
    ["我们的搜索功能，搜索", "搜索", 2],
    ["検索エンジン", "検索", 1],
    ["Été, étés", "été", 2],
    ["then read on.", '"read on"', 1],
    ["reread only", '"read on"', 0],
    ["read onward", '"read on"', 0],
    ["read ones", '"read on"', 1],
    ["read only", '"read on"', 0],
  ])("%j holds %j credited %d times", (text, q, expected) => {
    expect(count(text, q)).toBe(expected);
  });
});

describe("bestLines", () => {
  test("a later line holding every term wins over earlier ones", () => {
    const text = [
      "alpha",
      "alpha again",
      "beta",
      "nothing",
      "alpha beta gamma",
      "gamma",
    ].join("\n");
    const found = bestLines(text, searchTerms("alpha beta gamma"));
    expect(found.count).toBe(5);
    expect(found.lines.map((line) => line.line)).toEqual([1, 2, 5]);
  });

  test("credited matches beat inner ones, then the earliest", () => {
    const text = ["reclaim", "claimUploads", "a claim", "claims"].join("\n");
    const found = bestLines(text, searchTerms("claim"), 2);
    expect(found.count).toBe(4);
    expect(found.lines.map((line) => line.text)).toEqual(["a claim", "claims"]);
  });

  test("keeps every line in order when they fit", () => {
    const found = bestLines("b\na b\na", searchTerms("a b"));
    expect(found.lines.map((line) => line.line)).toEqual([1, 2, 3]);
  });
});
