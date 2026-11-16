// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { outlineRows } from "../../../src/server/mcp-server/outline.ts";
import { SEARCH_LINE_CHARS } from "../../../src/shared/api/knowledge.ts";

const texts = (text: string) => outlineRows(text).map((row) => row.text);

test("reads ATX headings and their closing runs", () => {
  expect(
    outlineRows(
      [
        "# foo#",
        "## foo ##  ",
        "### a \t#\t",
        "#",
        "#\r",
        "#   \r",
        "# ##",
        "# a  \r",
        "#x",
        "####### seven",
        "# a\rb",
        "# a b",
        "###### six # # ",
      ].join("\n"),
    ),
  ).toEqual([
    { line: 1, level: 1, text: "foo#" },
    { line: 2, level: 2, text: "foo" },
    { line: 3, level: 3, text: "a" },
    { line: 4, level: 1, text: "" },
    { line: 5, level: 1, text: "" },
    { line: 6, level: 1, text: "" },
    { line: 7, level: 1, text: "##" },
    { line: 8, level: 1, text: "a  " },
    { line: 13, level: 6, text: "six #" },
  ]);
});

test("reads a heading of a long blank run", () => {
  const blanks = " ".repeat(262_000);
  expect(texts(`# a${blanks}#b`)).toEqual([
    `a${blanks}#b`.slice(0, SEARCH_LINE_CHARS),
  ]);
  expect(texts(`# a${blanks}#`)).toEqual(["a"]);
  expect(texts(`#${blanks}\rX\n## b`)).toEqual(["b"]);
});
