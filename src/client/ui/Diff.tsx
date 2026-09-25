// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a change did to a text, from lib/diff.ts: the old and new
// numbers, a sign and the line, each change with the lines around it,
// and each unchanged run a fold that opens in place. A diff too large
// to compare draws nothing; the view says so and offers the text.

import { useMemo, useState } from "preact/hooks";
import { type DiffOp, diffRows, type LineDiff } from "../lib/diff.ts";
import "./diff.css";

const SIGN = { same: "", add: "+", del: "−" } as const;

function Line({ op }: { op: DiffOp }) {
  const c = op.kind === "same" ? "" : ` diff-${op.kind}`;
  return (
    <>
      <span class={`diff-num${c}`}>{op.old ?? ""}</span>
      <span class={`diff-num${c}`}>{op.new ?? ""}</span>
      <span class={`diff-sign${c}`}>{SIGN[op.kind]}</span>
      <span class={`diff-text${c}`}>{op.text}</span>
    </>
  );
}

export function Diff({ diff }: { diff: LineDiff }) {
  // the folds opened, by the op each starts at; a new diff starts closed
  const [open, setOpen] = useState<{ of: LineDiff; at: Set<number> }>({
    of: diff,
    at: new Set(),
  });
  const at = open.of === diff ? open.at : null;
  const rows = useMemo(
    () => (diff.tooLarge ? [] : diffRows(diff.ops, at ?? undefined)),
    [diff, at],
  );
  if (diff.tooLarge) return null;
  return (
    <div class="diff">
      {rows.map((row) =>
        row.kind === "line" ? (
          <Line key={`${row.op.old}:${row.op.new}`} op={row.op} />
        ) : (
          <button
            key={`f${row.from}`}
            type="button"
            class="diff-fold"
            onClick={() =>
              setOpen({ of: diff, at: new Set([...(at ?? []), row.from]) })
            }
          >
            {row.to - row.from} unchanged lines
          </button>
        ),
      )}
    </div>
  );
}

// the change's size in a band: "+3 −1"
export function DiffStat({
  added,
  removed,
}: {
  added: number;
  removed: number;
}) {
  return (
    <span class="diff-stat">
      <span class="diff-stat-add">+{added}</span>{" "}
      <span class="diff-stat-del">
        {SIGN.del}
        {removed}
      </span>
    </span>
  );
}
