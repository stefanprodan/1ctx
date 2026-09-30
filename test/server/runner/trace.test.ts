// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The trace another agent reads of a turn: calls only, one line each,
// on the fixture of a summoned turn.

import { describe, expect, test } from "bun:test";
import {
  summary,
  TRACE_HEADING,
  TRACE_LINE_CHARS,
  TRACE_LINES,
  type TraceCall,
  trace,
  traceCalls,
  traceLine,
} from "../../../src/server/runner/trace.ts";
import { TRACE, TURN } from "../../fixtures/runner/trace.ts";

const done = (name: string, args: unknown): TraceCall => ({
  name,
  arguments: JSON.stringify(args),
  status: "done",
});

describe("the trace", () => {
  test("a turn's calls, never their results, reasoning or signatures", () => {
    const text = trace(traceCalls(TURN));
    expect(text).toBe(TRACE);
    expect(text).not.toContain("result the trace never carries");
    expect(text).not.toContain("thinking");
    expect(text).not.toContain("sig-never-shown");
    expect(text).not.toContain("It is true");
  });

  test("the same calls give the same bytes", () => {
    expect(trace(traceCalls(structuredClone(TURN)))).toBe(
      trace(traceCalls(TURN)),
    );
  });

  test("a turn without calls has no trace", () => {
    expect(trace([])).toBe("");
    expect(trace(traceCalls(TURN.filter((row) => row.slot !== "work")))).toBe(
      "",
    );
  });

  test("each tool is identified by what it was asked", () => {
    expect(summary(done("bash", { command: "ls /knowledge\nwc -l x" }))).toBe(
      "ls /knowledge",
    );
    expect(summary(done("websearch", { query: "q", domain: "d" }))).toBe("q");
    expect(summary(done("webfetch", { url: "https://x.io", start: 3 }))).toBe(
      "https://x.io",
    );
    expect(summary(done("skill_file", { name: "s", path: "a.md" }))).toBe("");
    expect(summary(done("notes", { path: "/knowledge/a.md", n: 1 }))).toBe(
      "/knowledge/a.md",
    );
    expect(summary(done("mcp__fs__read", { path: "/a", lines: 3 }))).toBe(
      "path=/a lines=3",
    );
    expect(summary({ name: "bash", arguments: "not json" })).toBe("not json");
  });

  test("a long line is cut before its status, at a code point", () => {
    const long = traceLine(done("bash", { command: "x".repeat(500) }));
    expect(long.length).toBe(TRACE_LINE_CHARS);
    expect(long).toEndWith("x… ok");
    const emoji = traceLine(done("bash", { command: "😀".repeat(300) }));
    expect(emoji.length).toBeLessThanOrEqual(TRACE_LINE_CHARS);
    expect(emoji).toEndWith("… ok");
    expect(emoji).not.toMatch(/[\ud800-\udbff]…/);
  });

  test("past the cap one line counts the calls left", () => {
    const calls = Array.from({ length: TRACE_LINES + 3 }, (_, i) =>
      done("bash", { command: `echo ${i}` }),
    );
    calls.push(done("bash", { command: "echo 0" }));
    calls.push(done("bash", { command: `echo ${TRACE_LINES + 1}` }));
    const lines = trace(calls).split("\n");
    expect(lines[0]).toBe(TRACE_HEADING);
    expect(lines[1]).toBe("bash echo 0 ok ×2");
    expect(lines).toHaveLength(TRACE_LINES + 2);
    expect(lines.at(-1)).toBe("and 4 more calls");
  });
});
