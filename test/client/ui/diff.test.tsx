// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a change did to a text, drawn: the numbers, the signs, the
// folds, and nothing when the texts are too large to compare.

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { diffLines } from "../../../src/client/lib/diff.ts";
import { Diff, DiffStat } from "../../../src/client/ui/Diff.tsx";

test("a changed line draws its deletion then its addition among the context", () => {
  const html = render(<Diff diff={diffLines("a\n<b>\nc\n", "a\nB\nc\n")} />);
  expect(html).toBe(
    '<div class="diff">' +
      '<span class="diff-num">1</span><span class="diff-num">1</span><span class="diff-sign"></span><span class="diff-text">a</span>' +
      '<span class="diff-num diff-del">2</span><span class="diff-num diff-del"></span><span class="diff-sign diff-del">−</span><span class="diff-text diff-del">&lt;b></span>' +
      '<span class="diff-num diff-add"></span><span class="diff-num diff-add">2</span><span class="diff-sign diff-add">+</span><span class="diff-text diff-add">B</span>' +
      '<span class="diff-num">3</span><span class="diff-num">3</span><span class="diff-sign"></span><span class="diff-text">c</span>' +
      "</div>",
  );
});

test("an unchanged run past the context is a fold that says its size", () => {
  const a = Array.from({ length: 30 }, (_, i) => `${i}`);
  const b = [...a];
  b[29] = "last";
  const html = render(<Diff diff={diffLines(a.join("\n"), b.join("\n"))} />);
  expect(html).toContain(
    '<button type="button" class="diff-fold">26 unchanged lines</button>',
  );
});

test("a diff too large to compare draws nothing", () => {
  expect(render(<Diff diff={{ tooLarge: true }} />)).toBe("");
});

test("the stat says what was added and removed", () => {
  expect(render(<DiffStat added={3} removed={1} />)).toBe(
    '<span class="diff-stat"><span class="diff-stat-add">+3</span> <span class="diff-stat-del">−1</span></span>',
  );
});
