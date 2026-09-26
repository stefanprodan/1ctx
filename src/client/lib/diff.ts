// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A line diff of two texts by Myers' shortest edit script, and the rows
// a page draws from it: each change with three lines around it, every
// longer unchanged run a fold. Within a change the deletions come
// first. Past a size the answer is tooLarge and nothing is compared, so
// a page never spends seconds on two big texts.

import { textLines } from "./lines.ts";

// both texts' lines together, and the edits the script may need
export const MAX_DIFF_LINES = 10_000;
export const MAX_DIFF_EDITS = 1_000;
const DIFF_CONTEXT = 3;

export type DiffOp = {
  kind: "same" | "add" | "del";
  // the line's number in the old text and the new, null where it is
  // not in that text
  old: number | null;
  new: number | null;
  text: string;
};

export type LineDiff =
  | { tooLarge: false; ops: DiffOp[]; added: number; removed: number }
  | { tooLarge: true };

// an empty text has no lines, not one empty line
const linesOf = (text: string) => (text === "" ? [] : textLines(text));

export function diffLines(before: string, after: string): LineDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length + b.length > MAX_DIFF_LINES) return { tooLarge: true };
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = script(a.slice(start, endA), b.slice(start, endB));
  if (middle === null) return { tooLarge: true };
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) {
    ops.push({ kind: "same", old: i + 1, new: i + 1, text: a[i]! });
  }
  let x = start;
  let y = start;
  let dels: DiffOp[] = [];
  let adds: DiffOp[] = [];
  const flush = () => {
    ops.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const kind of middle) {
    if (kind === "same") {
      flush();
      ops.push({ kind, old: x + 1, new: y + 1, text: a[x]! });
      x++;
      y++;
    } else if (kind === "del") {
      dels.push({ kind, old: x + 1, new: null, text: a[x]! });
      x++;
    } else {
      adds.push({ kind, old: null, new: y + 1, text: b[y]! });
      y++;
    }
  }
  flush();
  for (let i = endA; i < a.length; i++) {
    const j = i - endA + endB;
    ops.push({ kind: "same", old: i + 1, new: j + 1, text: a[i]! });
  }
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { tooLarge: false, ops, added, removed };
}

// Myers' greedy walk over the edit graph, keeping each round's frontier
// to walk back; null past MAX_DIFF_EDITS
function script(a: string[], b: string[]): DiffOp["kind"][] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return [
      ...Array<DiffOp["kind"]>(n).fill("del"),
      ...Array<DiffOp["kind"]>(m).fill("add"),
    ];
  }
  // lines as numbers, so the walk compares integers
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) {
      v = ids.size;
      ids.set(s, v);
    }
    return v;
  };
  const x0 = Int32Array.from(a, id);
  const y0 = Int32Array.from(b, id);
  const max = Math.min(n + m, MAX_DIFF_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is the frontier before round d, from diagonal -d-1 to d+1
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && x0[x] === y0[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  const out: DiffOp["kind"][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const t = trace[d]!;
    const at = (k: number) => t[k + d + 1]!;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push("same");
      x--;
      y--;
    }
    if (x === prevX) {
      out.push("add");
      y--;
    } else {
      out.push("del");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    out.push("same");
    x--;
    y--;
  }
  return out.reverse();
}

export type DiffRow =
  | { kind: "line"; op: DiffOp }
  // an unchanged run: ops from `from` up to `to`, not included
  | { kind: "fold"; from: number; to: number };

// the rows a page draws: every change and DIFF_CONTEXT lines each side;
// an unchanged run longer than one line is a fold unless its start is
// in `open`. One line alone is drawn, since its fold takes as much room
export function diffRows(
  ops: readonly DiffOp[],
  open: ReadonlySet<number> = new Set(),
): DiffRow[] {
  const near = new Uint8Array(ops.length);
  ops.forEach((op, i) => {
    if (op.kind === "same") return;
    const last = Math.min(ops.length - 1, i + DIFF_CONTEXT);
    for (let j = Math.max(0, i - DIFF_CONTEXT); j <= last; j++) near[j] = 1;
  });
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (near[i]) {
      rows.push({ kind: "line", op: ops[i]! });
      i++;
      continue;
    }
    let end = i;
    while (end < ops.length && !near[end]) end++;
    if (end - i > 1 && !open.has(i)) {
      rows.push({ kind: "fold", from: i, to: end });
    } else {
      for (let j = i; j < end; j++) rows.push({ kind: "line", op: ops[j]! });
    }
    i = end;
  }
  return rows;
}
