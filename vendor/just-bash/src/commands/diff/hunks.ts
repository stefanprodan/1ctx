/**
 * (1ctx) diff's changes and hunks: runs of deleted and inserted lines at
 * one place are a change, and changes closer than twice the context are
 * one hunk. A hunk whose changes are all ignorable (-B, -I) is dropped.
 */

import type { Comparison } from "./engine.js";

/** Lines a0 to a1 of the first file became b0 to b1 of the second. */
export interface Change {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  ignorable: boolean;
}

/** Changes with the context around them, as lines a0 to a1 and b0 to b1. */
export interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  changes: Change[];
}

export function changesOf({ deleted, inserted }: Comparison): Change[] {
  const n = deleted.length;
  const m = inserted.length;
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if ((i < n && deleted[i]) || (j < m && inserted[j])) {
      const a0 = i;
      const b0 = j;
      while (i < n && deleted[i]) i++;
      while (j < m && inserted[j]) j++;
      changes.push({ a0, a1: i, b0, b1: j, ignorable: false });
    } else {
      i++;
      j++;
    }
  }
  return changes;
}

export function hunksOf(
  changes: Change[],
  context: number,
  n: number,
  m: number,
): Hunk[] {
  const hunks: Hunk[] = [];
  let group: Change[] = [];
  const close = () => {
    if (group.length === 0) return;
    if (group.some((c) => !c.ignorable)) {
      const first = group[0];
      const last = group[group.length - 1];
      const before = Math.min(context, first.a0, first.b0);
      const after = Math.min(context, n - last.a1, m - last.b1);
      hunks.push({
        a0: first.a0 - before,
        a1: last.a1 + after,
        b0: first.b0 - before,
        b1: last.b1 + after,
        changes: group,
      });
    }
    group = [];
  };
  for (const change of changes) {
    const last = group[group.length - 1];
    // GNU joins an ignorable change to the hunk before it only within
    // fewer lines than the context, a real one within twice the context
    const limit = change.ignorable ? context - 1 : 2 * context;
    if (last && change.a0 - last.a1 > limit) close();
    group.push(change);
  }
  close();
  return hunks;
}
