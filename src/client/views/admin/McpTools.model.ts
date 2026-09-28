// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { McpToolSummary } from "../../../shared/contracts/mcp.ts";
import {
  type Decided,
  decide,
  type Patterns,
  type ToolSide,
  unmatched,
} from "../../../shared/mcp.ts";
import { isPattern, MAX_PATTERNS } from "../../../shared/words.ts";
import { plural } from "../../lib/format.ts";
import { matches } from "../../lib/search.ts";

// the page's order; decide() applies excluded, then read, then write
export type MatcherSide = "excluded" | "read" | "write";
export const MATCHER_SIDES: { side: MatcherSide; label: string }[] = [
  { side: "read", label: "Read" },
  { side: "write", label: "Write" },
  { side: "excluded", label: "Excluded" },
];

export const SIDE_WORDS: Record<ToolSide, string> = {
  read: "Read",
  write: "Write",
  excluded: "Excluded",
  unusable: "Unusable",
};

type Tools = Pick<McpToolSummary, "name" | "unusable">[];

// a matcher an earlier one outranks decides none but still matches,
// so it is not marked as a typo
export type Matcher = { pattern: string; decides: number; matches: boolean };

export function matchers(
  server: string,
  tools: Tools,
  patterns: Patterns,
): Record<MatcherSide, Matcher[]> {
  const decided = decide(server, tools, patterns);
  const none = new Set(
    unmatched(
      tools.map((t) => t.name),
      patterns,
    ),
  );
  const of = (side: MatcherSide) =>
    patterns[side].map((pattern) => {
      let decides = 0;
      for (const d of decided.values()) {
        if (d.side === side && d.by === pattern) decides++;
      }
      return { pattern, decides, matches: !none.has(pattern) };
    });
  return { read: of("read"), write: of("write"), excluded: of("excluded") };
}

export function addMatcher(
  patterns: Patterns,
  side: MatcherSide,
  text: string,
): { patterns: Patterns } | { problem: string } {
  const pattern = text.trim();
  if (pattern === "") return { problem: "Type a tool name or a prefix*" };
  if (!isPattern(pattern)) {
    return {
      problem: "Letters, digits and _ . - only, with * last for a prefix",
    };
  }
  if (patterns[side].includes(pattern)) {
    return { problem: `${pattern} is already there` };
  }
  if (patterns[side].length >= MAX_PATTERNS) {
    return { problem: `At most ${MAX_PATTERNS} matchers a side` };
  }
  return { patterns: { ...patterns, [side]: [...patterns[side], pattern] } };
}

export function removeMatcher(
  patterns: Patterns,
  side: MatcherSide,
  pattern: string,
): Patterns {
  return { ...patterns, [side]: patterns[side].filter((p) => p !== pattern) };
}

export function decidedWords(d: Decided): string {
  if (d.side === "unusable") return "";
  if (d.by !== null) return `by ${d.by}`;
  return d.side === "write" ? "by default" : "no match";
}

export type SideFilter = "all" | ToolSide;

export function shownTools<T extends Tools[number] & { description: string }>(
  tools: T[],
  decided: Map<string, Decided>,
  q: string,
  filter: SideFilter,
): T[] {
  return tools
    .filter(
      (t) =>
        (filter === "all" || decided.get(t.name)?.side === filter) &&
        matches(q, [t.name, t.description]),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function sideCounts(
  decided: Map<string, Decided>,
): Record<ToolSide, number> {
  const out = { read: 0, write: 0, excluded: 0, unusable: 0 };
  for (const d of decided.values()) out[d.side]++;
  return out;
}

type Stay = { name: string; side: ToolSide; by: string };

type Moved = {
  patterns: Patterns;
  moved: number;
  stays: Stay[];
};

// Moving picked tools to a side takes their exact names out of the
// other lists and adds them to the side's, unless the tool lands there
// without one. The write list keeps a name when taking it would empty
// the list, since an empty write list takes every unmatched tool; a
// write name never outranks read or excluded anyway. An empty write
// list gets no name for the same reason: its tools are written by
// default. A tool a prefix earlier in the order holds stays, and says so.
export function moveTools(
  server: string,
  tools: Tools,
  patterns: Patterns,
  names: string[],
  target: MatcherSide,
): Moved | { problem: string } {
  const decidedBefore = decide(server, tools, patterns);
  const picked = names.filter(
    (n) => decidedBefore.has(n) && decidedBefore.get(n)!.side !== "unusable",
  );
  const set = new Set(picked);
  const next: Patterns = {
    read: patterns.read,
    write: patterns.write,
    excluded: patterns.excluded,
  };
  for (const side of ["read", "excluded", "write"] as const) {
    if (side === target) continue;
    const kept = next[side].filter((p) => !set.has(p));
    if (side === "write" && kept.length === 0 && next.write.length > 0) {
      continue;
    }
    next[side] = kept;
  }
  const decided = decide(server, tools, next);
  const wanted = picked.filter(
    (n) =>
      decided.get(n)!.side !== target &&
      !next[target].includes(n) &&
      !(target === "write" && next.write.length === 0),
  );
  // a name an earlier list outranks would sit there deciding nothing
  const trial = decide(server, tools, {
    ...next,
    [target]: [...next[target], ...wanted],
  });
  const add = wanted.filter((n) => trial.get(n)!.side === target);
  if (next[target].length + add.length > MAX_PATTERNS) {
    return { problem: `At most ${MAX_PATTERNS} matchers a side` };
  }
  next[target] = [...next[target], ...add];
  const after = decide(server, tools, next);
  const stays: Stay[] = [];
  let moved = 0;
  for (const name of picked) {
    const d = after.get(name)!;
    if (d.side === target) {
      if (decidedBefore.get(name)!.side !== target) moved++;
    } else {
      stays.push({ name, side: d.side, by: d.by ?? "" });
    }
  }
  return { patterns: next, moved, stays };
}

export function moveWords(result: Moved, target: MatcherSide): string[] {
  const out: string[] = [];
  const label = MATCHER_SIDES.find((s) => s.side === target)!.label;
  if (result.moved > 0) {
    out.push(`${plural(result.moved, "tool", "tools")} moved to ${label}`);
  }
  const held = new Map<string, Stay[]>();
  for (const s of result.stays) {
    const key = `${s.side}\n${s.by}`;
    held.set(key, [...(held.get(key) ?? []), s]);
  }
  for (const [key, stays] of held) {
    const [side, by] = key.split("\n") as [ToolSide, string];
    const who =
      stays.length === 1 ? `${stays[0]!.name} stays` : `${stays.length} stay`;
    out.push(`${who} ${SIDE_WORDS[side].toLowerCase()} by ${by}`);
  }
  if (out.length === 0) out.push(`Already ${label}`);
  return out;
}
