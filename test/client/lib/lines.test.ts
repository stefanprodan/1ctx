// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { splitLines, textLines } from "../../../src/client/lib/lines.ts";

test("a span that crosses a newline is closed and reopened on each line", () => {
  const html =
    '<span class="hljs-comment">/* one\ntwo\nthree */</span> x\n<span class="a">b</span>';
  expect(splitLines(html)).toEqual([
    '<span class="hljs-comment">/* one</span>',
    '<span class="hljs-comment">two</span>',
    '<span class="hljs-comment">three */</span> x',
    '<span class="a">b</span>',
  ]);
});

test("nested spans reopen outermost first", () => {
  const html = '<span class="o">a<span class="i">b\nc</span>d</span>';
  expect(splitLines(html)).toEqual([
    '<span class="o">a<span class="i">b</span></span>',
    '<span class="o"><span class="i">c</span>d</span>',
  ]);
});

test("entities, a bare < and CRLF pass as text; a stray close is dropped", () => {
  expect(splitLines("a &lt; b\r\n< c</span>\n")).toEqual([
    "a &lt; b",
    "< c",
    "",
  ]);
});

test("a final newline ends the last line", () => {
  expect(textLines("a\nb\n")).toEqual(["a", "b"]);
  expect(textLines("a\r\nb")).toEqual(["a", "b"]);
  expect(textLines("")).toEqual([""]);
  expect(textLines("\n")).toEqual([""]);
  expect(textLines("a\n\n")).toEqual(["a", ""]);
});
