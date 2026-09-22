// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { tokens } from "../../../src/server/lib/tokens.ts";
import {
  CONTEXT_CUT,
  cutResult,
  fitResults,
  resultsFit,
} from "../../../src/server/runner/results.ts";

const calls = ["large", "small"].map((id) => ({
  id,
  name: "bash",
  arguments: "{}",
}));

const size = (index: number, content: string) =>
  tokens(
    JSON.stringify({
      role: "tool",
      tool_call_id: calls[index]!.id,
      content,
    }),
  );

test("results are cut largest first and the stored suffix stays intact", () => {
  const tail = "exit 1\nwrote notes.md (rev 2, 8 lines)";
  const results = [
    {
      content: "long output\n".repeat(1000) + tail,
      error: true,
      tail: tail.length,
    },
    { content: "small", error: false },
  ];
  const fitted = fitResults(calls, results, 500);
  expect(fitted).toMatchObject({ cut: true, fits: true });
  expect(fitted.results[1]).toEqual(results[1]);
  expect(fitted.results[0]).toMatchObject({ error: true });
  expect(fitted.results[0]!.content).toEndWith(`${tail}\n${CONTEXT_CUT}`);
  expect(
    fitted.results.reduce((sum, result, i) => sum + size(i, result.content), 0),
  ).toBeLessThanOrEqual(500);
  expect(results[0]!.content).not.toContain(CONTEXT_CUT);
});

test("result counting includes JSON escapes and framing at the exact boundary", () => {
  const results = [
    { content: '"\\\n'.repeat(500), error: false },
    { content: "ok", error: false },
  ];
  const exact = results.reduce(
    (sum, result, i) => sum + size(i, result.content),
    0,
  );
  expect(fitResults(calls, results, exact)).toEqual({
    results,
    cut: false,
    fits: true,
  });
  const fitted = fitResults(calls, results, exact - 1);
  expect(fitted).toMatchObject({ cut: true, fits: true });
  expect(
    fitted.results.reduce((sum, result, i) => sum + size(i, result.content), 0),
  ).toBeLessThan(exact);
  expect(fitResults(calls, results, null)).toEqual({
    results,
    cut: false,
    fits: true,
  });
});

test("a protected tail too large for the room is kept and reported as not fitting", () => {
  const tail = "exit 0\nwrote file.md (rev 1, 1 lines)";
  const fitted = fitResults(
    [calls[0]!],
    [{ content: "read ".repeat(1000) + tail, error: false, tail: tail.length }],
    1,
  );
  expect(fitted).toMatchObject({ cut: true, fits: false });
  expect(fitted.results[0]!.content).toEndWith(`${tail}\n${CONTEXT_CUT}`);
});

test("character cuts preserve tails and do not split surrogate pairs", () => {
  const tail = "exit 0";
  expect(
    cutResult(
      {
        content: `a\u{1f680}bc${tail}`,
        error: false,
        tail: tail.length,
      },
      tail.length + 2,
    ),
  ).toEqual({
    content: `a${tail}`,
    error: false,
    tail: tail.length,
  });
  expect(() =>
    cutResult({ content: tail, error: false, tail: tail.length }, 1),
  ).toThrow("the result tail exceeds the result limit");
  const result = { content: tail, error: false };
  expect(cutResult(result, tail.length)).toBe(result);
});

test("the early-storage bound covers every JSON byte and unknown windows", () => {
  expect(resultsFit(calls, 50_000, 100)).toBe(false);
  expect(resultsFit(calls, 50_000, 1_000_000)).toBe(true);
  expect(resultsFit(calls, 50_000, null)).toBe(true);
  const escaped = "\u0000".repeat(50_000);
  const actual = calls.reduce((sum, _, i) => sum + size(i, escaped), 0);
  expect(actual).toBeLessThanOrEqual(1_000_000);
});

test("opened copies survive character and context result cuts", () => {
  const opened = [
    {
      path: "/tmp/page.html",
      kind: "visual" as const,
      language: null,
      bytes: 12,
      lines: 1,
      title: "Page",
      text: "<p>Page</p>",
    },
  ];
  const result = {
    content: `${"read output ".repeat(100)}exit 0`,
    error: false,
    tail: 6,
    opened,
  };
  expect(cutResult(result, 40).opened).toBe(opened);
  const fitted = fitResults([calls[0]!], [result], 20);
  expect(fitted.cut).toBe(true);
  expect(fitted.results[0]!.opened).toBe(opened);
});
