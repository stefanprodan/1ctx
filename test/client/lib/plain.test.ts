// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A Markdown first line as a one-line summary shows it: the words a
// reader sees, with no Markdown marks left.

import { describe, expect, test } from "bun:test";
import { plainLine } from "../../../src/client/lib/plain.ts";

describe("plainLine", () => {
  test.each([
    // links keep their words, images their alt, autolinks the address
    [
      "Folded it. See [the layout brief](https://fluxcd.io/a?b=c) now",
      "Folded it. See the layout brief now",
    ],
    ['[a "title" link](https://x.test "T")', 'a "title" link'],
    ["![chart](chart.png) attached", "chart attached"],
    ["See [docs][ref] first", "See docs first"],
    [
      "Opened <https://github.com/o/r/pull/12>",
      "Opened https://github.com/o/r/pull/12",
    ],
    // inline code without its backticks, kept as written
    ["Run `make test` then ``a `b` c``", "Run make test then a `b` c"],
    ["Keep `**not bold**` as is", "Keep **not bold** as is"],
    // emphasis of every kind
    [
      "**bold**, *em*, ***both***, __u__, _e_, ~~gone~~",
      "bold, em, both, u, e, gone",
    ],
    ["snake_case_name stays", "snake_case_name stays"],
    ["2 * 3 * 4", "2 * 3 * 4"],
    // what opens a line
    ["## Plan ##", "Plan"],
    ["# Title", "Title"],
    ["- item", "item"],
    ["* item", "item"],
    ["+ item", "item"],
    ["12. step", "step"],
    ["3) step", "step"],
    ["> > quoted", "quoted"],
    ["- [x] done task", "done task"],
    ["> - **mixed**", "mixed"],
    // escapes resolved, never read as marks
    ["\\*not em\\* and \\[not a link\\](x)", "*not em* and [not a link](x)"],
    ["a \\_b\\_ c", "a _b_ c"],
    // an escaped backtick opens no code span; code keeps its backslashes
    ["\\`not code\\` here", "`not code` here"],
    ["`a\\*b` and \\*c\\*", "a\\*b and *c*"],
    // CJK passes through, its emphasis dropped
    [
      "**中文** 的 [链接](https://x.test) と `コード`",
      "中文 的 链接 と コード",
    ],
    // the first line with words, spaces collapsed
    ["\n\n  Which   branch?\nsecond", "Which branch?"],
    // a line with nothing left gives way to the next with words
    ["#\nTitle below", "Title below"],
    ["![](shot.png)\n\nThe caption", "The caption"],
    ["```bash\nmake test\n```", "make test"],
    ["~~~\n\n## Notes", "Notes"],
    ["``` \n> ![]()\nlast", "last"],
    ["#\n![](x.png)", ""],
    ["```a``` inline", "a inline"],
    ["", ""],
  ])("%p", (input, want) => {
    expect(plainLine(input)).toBe(want);
  });
});
