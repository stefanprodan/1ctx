// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  type DiffOp,
  diffLines,
  diffRows,
  MAX_DIFF_EDITS,
  MAX_DIFF_LINES,
} from "../../../src/client/lib/diff.ts";

// ops as one string each: the sign, the old and new numbers, the text
const show = (ops: DiffOp[]) =>
  ops.map(
    (op) =>
      `${op.kind === "same" ? " " : op.kind === "add" ? "+" : "-"}${op.old ?? "."}:${op.new ?? "."} ${op.text}`,
  );

const diff = (a: string, b: string) => {
  const d = diffLines(a, b);
  if (d.tooLarge) throw new Error("too large");
  return d;
};

// both texts come back from the ops
const rebuild = (ops: DiffOp[]) => ({
  old: ops.filter((op) => op.kind !== "add").map((op) => op.text),
  new: ops.filter((op) => op.kind !== "del").map((op) => op.text),
});

test("a changed line is its deletion then its addition, numbered in each text", () => {
  const d = diff("a\nb\nc\n", "a\nB\nc\n");
  expect(show(d.ops)).toEqual([" 1:1 a", "-2:. b", "+.:2 B", " 3:3 c"]);
  expect([d.added, d.removed]).toEqual([1, 1]);
});

test("within a change every deletion comes before the additions", () => {
  const d = diff("x\n1\n2\ny\nk\np\nq", "x\nA\n1\nB\ny\nk\nP\nQ");
  // each run of changes, as its signs
  const runs = d.ops
    .map((op) => (op.kind === "same" ? " " : op.kind === "add" ? "+" : "-"))
    .join("")
    .split(" ")
    .filter((run) => run !== "");
  for (const run of runs) expect(run).toMatch(/^-*\+*$/);
  expect(runs).toContain("--++");
  expect(rebuild(d.ops)).toEqual({
    old: ["x", "1", "2", "y", "k", "p", "q"],
    new: ["x", "A", "1", "B", "y", "k", "P", "Q"],
  });
});

test("an empty text has no lines", () => {
  expect(show(diff("", "a\nb").ops)).toEqual(["+.:1 a", "+.:2 b"]);
  expect(show(diff("a\n", "").ops)).toEqual(["-1:. a"]);
  expect(diff("", "").ops).toEqual([]);
  expect(diff("same\n", "same").ops.every((op) => op.kind === "same")).toBe(
    true,
  );
});

test("the script is the shortest one on texts that shuffle", () => {
  const a = "a b c a b b a".split(" ").join("\n");
  const b = "c b a b a c".split(" ").join("\n");
  const d = diff(a, b);
  // Myers' own example: five edits
  expect(d.added + d.removed).toBe(5);
  expect(rebuild(d.ops)).toEqual({ old: a.split("\n"), new: b.split("\n") });
});

test("a random edit keeps both texts", () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let round = 0; round < 50; round++) {
    const a = Array.from({ length: 40 }, () => String(Math.floor(rand() * 6)));
    const b = a
      .filter(() => rand() > 0.2)
      .flatMap((line) => (rand() > 0.8 ? [line, "new"] : [line]));
    const d = diff(a.join("\n"), b.join("\n"));
    expect(rebuild(d.ops)).toEqual({ old: a, new: b });
  }
});

test("past the size the diff is too large and compares nothing", () => {
  const big = Array.from({ length: MAX_DIFF_LINES / 2 + 1 }, (_, i) => `${i}`);
  expect(diffLines(big.join("\n"), big.join("\n"))).toEqual({
    tooLarge: true,
  });
  // few lines, but more edits than the walk may take
  const n = MAX_DIFF_EDITS;
  const a = Array.from({ length: n }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: n }, (_, i) => `b${i}`).join("\n");
  expect(diffLines(a, b)).toEqual({ tooLarge: true });
  // a long text with a small change is compared: the ends are trimmed
  const long = Array.from({ length: 4000 }, (_, i) => `${i}`);
  const changed = [...long];
  changed[2000] = "x";
  const d = diffLines(long.join("\n"), changed.join("\n"));
  expect(d.tooLarge ? null : [d.added, d.removed]).toEqual([1, 1]);
});

test("rows keep three lines round a change and fold the rest", () => {
  const a = Array.from({ length: 20 }, (_, i) => `${i + 1}`);
  const b = [...a];
  b[9] = "ten";
  const d = diff(a.join("\n"), b.join("\n"));
  const rows = diffRows(d.ops);
  expect(
    rows.map((row) =>
      row.kind === "fold"
        ? `fold ${row.to - row.from}`
        : `${row.op.kind} ${row.op.text}`,
    ),
  ).toEqual([
    "fold 6",
    "same 7",
    "same 8",
    "same 9",
    "del 10",
    "add ten",
    "same 11",
    "same 12",
    "same 13",
    "fold 7",
  ]);
  // an opened fold draws its lines
  const first = rows[0]!;
  const opened = diffRows(
    d.ops,
    new Set([first.kind === "fold" ? first.from : -1]),
  );
  expect(opened[0]).toEqual({ kind: "line", op: d.ops[0]! });
  expect(opened).toHaveLength(rows.length - 1 + 6);
});

test("one unchanged line between the contexts is drawn, never folded", () => {
  const a = Array.from({ length: 9 }, (_, i) => `${i}`);
  const b = [...a];
  b[0] = "x";
  b[8] = "y";
  const rows = diffRows(diff(a.join("\n"), b.join("\n")).ops);
  expect(rows.every((row) => row.kind === "line")).toBe(true);
  // identical texts are one fold
  const same = diffRows(diff("a\nb\nc", "a\nb\nc").ops);
  expect(same).toEqual([{ kind: "fold", from: 0, to: 3 }]);
});
