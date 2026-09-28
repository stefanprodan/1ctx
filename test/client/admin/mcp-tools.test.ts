// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A server's Tools tab without a DOM, on a server shaped like GitHub's
// and staging's matchers for it: what each matcher decides, a matcher
// typed in, the search and the side, and moves that write exact names
// and say what a matcher earlier in the order keeps.

import { describe, expect, test } from "bun:test";
import {
  addMatcher,
  decidedWords,
  matchers,
  moveTools,
  moveWords,
  removeMatcher,
  shownTools,
  sideCounts,
} from "../../../src/client/views/admin/McpTools.model.ts";
import { classify, decide, type Patterns } from "../../../src/shared/mcp.ts";

const NAMES = [
  "get_me",
  "get_commit",
  "list_issues",
  "search_code",
  "issue_read",
  "issue_write",
  "delete_file",
  "a.b",
];
const tools = NAMES.map((name) => ({
  name,
  unusable: null,
  description: `${name} does a thing`,
}));
const PATTERNS: Patterns = {
  read: ["get_*", "list_*", "search_*"],
  write: ["*"],
  excluded: [],
};

const sideOf = (patterns: Patterns, name: string) =>
  classify("github", tools, patterns).get(name);

describe("the matchers", () => {
  test("each decides the tools no earlier one took", () => {
    const m = matchers("github", tools, PATTERNS);
    expect(m.read).toEqual([
      { pattern: "get_*", decides: 2, matches: true },
      { pattern: "list_*", decides: 1, matches: true },
      { pattern: "search_*", decides: 1, matches: true },
    ]);
    // a.b breaks the wire name's rule, so no matcher decides it
    expect(m.write).toEqual([{ pattern: "*", decides: 3, matches: true }]);
  });

  test("an outranked matcher decides none, a typo matches none", () => {
    const m = matchers("github", tools, {
      read: ["issue_read", "gte_*"],
      write: [],
      excluded: ["issue_*"],
    });
    expect(m.read).toEqual([
      { pattern: "issue_read", decides: 0, matches: true },
      { pattern: "gte_*", decides: 0, matches: false },
    ]);
    expect(m.excluded).toEqual([
      { pattern: "issue_*", decides: 2, matches: true },
    ]);
  });

  test("the explanation names the matcher, default or lack of a match", () => {
    const decided = decide("github", tools, PATTERNS);
    expect(decidedWords(decided.get("get_me")!)).toBe("by get_*");
    expect(decidedWords(decided.get("a.b")!)).toBe("");
    const empty = decide("github", tools, { ...PATTERNS, write: [] });
    expect(decidedWords(empty.get("issue_read")!)).toBe("by default");
    const listed = decide("github", tools, {
      ...PATTERNS,
      write: ["delete_*"],
    });
    expect(decidedWords(listed.get("issue_read")!)).toBe("no match");
  });

  test("a matcher typed in is checked and kept once", () => {
    expect(addMatcher(PATTERNS, "excluded", " delete_* ")).toEqual({
      patterns: { ...PATTERNS, excluded: ["delete_*"] },
    });
    expect(addMatcher(PATTERNS, "read", "get_*")).toEqual({
      problem: "get_* is already there",
    });
    expect(addMatcher(PATTERNS, "read", "")).toHaveProperty("problem");
    expect(addMatcher(PATTERNS, "read", "a b")).toHaveProperty("problem");
    expect(addMatcher(PATTERNS, "read", "*get")).toHaveProperty("problem");
    const full = {
      ...PATTERNS,
      read: Array.from({ length: 50 }, (_, i) => `t${i}`),
    };
    expect(addMatcher(full, "read", "x")).toHaveProperty("problem");
    expect(removeMatcher(PATTERNS, "read", "list_*").read).toEqual([
      "get_*",
      "search_*",
    ]);
  });
});

describe("the list", () => {
  test("the search and the side narrow it, by name", () => {
    const decided = decide("github", tools, PATTERNS);
    expect(
      shownTools(tools, decided, "issue", "all").map((t) => t.name),
    ).toEqual(["issue_read", "issue_write", "list_issues"]);
    expect(shownTools(tools, decided, "", "read").map((t) => t.name)).toEqual([
      "get_commit",
      "get_me",
      "list_issues",
      "search_code",
    ]);
    expect(shownTools(tools, decided, "a thing", "unusable")).toHaveLength(1);
    expect(sideCounts(decided)).toEqual({
      read: 4,
      write: 3,
      excluded: 0,
      unusable: 1,
    });
  });
});

describe("a move", () => {
  test("to Read adds the exact names", () => {
    const r = moveTools("github", tools, PATTERNS, ["issue_read"], "read");
    if ("problem" in r) throw new Error(r.problem);
    expect(r.patterns.read).toEqual([
      "get_*",
      "list_*",
      "search_*",
      "issue_read",
    ]);
    expect(r.patterns.write).toEqual(["*"]);
    expect(sideOf(r.patterns, "issue_read")).toBe("read");
    expect(moveWords(r, "read")).toEqual(["1 tool moved to Read"]);
  });

  test("to Write, a read prefix keeps the tool and says so", () => {
    const r = moveTools(
      "github",
      tools,
      PATTERNS,
      ["get_me", "get_commit", "issue_read"],
      "write",
    );
    if ("problem" in r) throw new Error(r.problem);
    // issue_read is already write through *, so no name is added
    expect(r.patterns).toEqual(PATTERNS);
    expect(r.stays.map((s) => s.name)).toEqual(["get_me", "get_commit"]);
    expect(moveWords(r, "write")).toEqual(["2 stay read by get_*"]);
  });

  test("to Excluded always lands, and back to Read takes the name out", () => {
    const out = moveTools("github", tools, PATTERNS, ["get_me"], "excluded");
    if ("problem" in out) throw new Error(out.problem);
    expect(out.patterns.excluded).toEqual(["get_me"]);
    expect(sideOf(out.patterns, "get_me")).toBe("excluded");
    const back = moveTools("github", tools, out.patterns, ["get_me"], "read");
    if ("problem" in back) throw new Error(back.problem);
    expect(back.patterns.excluded).toEqual([]);
    // get_* reads it again without its own name
    expect(back.patterns.read).toEqual(PATTERNS.read);
    expect(moveWords(back, "read")).toEqual(["1 tool moved to Read"]);
  });

  test("an excluded prefix keeps a tool from Read", () => {
    const patterns = { ...PATTERNS, excluded: ["issue_*"] };
    const r = moveTools("github", tools, patterns, ["issue_read"], "read");
    if ("problem" in r) throw new Error(r.problem);
    expect(r.patterns.read).not.toContain("issue_read");
    expect(moveWords(r, "read")).toEqual([
      "issue_read stays excluded by issue_*",
    ]);
  });

  test("an empty write list is never given a name", () => {
    const patterns = { read: ["issue_read"], write: [], excluded: [] };
    const r = moveTools("github", tools, patterns, ["issue_read"], "write");
    if ("problem" in r) throw new Error(r.problem);
    // taking the name out of read lets the default write it
    expect(r.patterns).toEqual({ read: [], write: [], excluded: [] });
    expect(sideOf(r.patterns, "get_me")).toBe("write");
    expect(moveWords(r, "write")).toEqual(["1 tool moved to Write"]);
  });

  test("the last write name stays, or every other tool would be written", () => {
    const patterns = { read: [], write: ["delete_file"], excluded: [] };
    const r = moveTools("github", tools, patterns, ["delete_file"], "read");
    if ("problem" in r) throw new Error(r.problem);
    expect(r.patterns.write).toEqual(["delete_file"]);
    expect(r.patterns.read).toEqual(["delete_file"]);
    expect(sideOf(r.patterns, "delete_file")).toBe("read");
    expect(sideOf(r.patterns, "issue_write")).toBe("excluded");
  });

  test("an unusable tool is never moved, a move past the cap is refused", () => {
    const r = moveTools("github", tools, PATTERNS, ["a.b"], "read");
    if ("problem" in r) throw new Error(r.problem);
    expect(r.patterns).toEqual(PATTERNS);
    expect(moveWords(r, "read")).toEqual(["Already Read"]);
    const full = {
      ...PATTERNS,
      excluded: Array.from({ length: 50 }, (_, i) => `t${i}`),
    };
    expect(
      moveTools("github", tools, full, ["get_me"], "excluded"),
    ).toHaveProperty("problem");
  });
});
