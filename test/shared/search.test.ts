// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  holdsAll,
  matchLines,
  matchText,
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

describe("matchText", () => {
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
