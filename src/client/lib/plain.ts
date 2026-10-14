// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A Markdown text's first line with words as a reader sees it, for a
// one-line summary: a link's words, code without its backticks, no
// emphasis, heading, quote or list marks, escapes resolved, spaces
// collapsed. A line left with nothing, such as a bare heading mark, an
// image with no alt or a code fence, gives way to the next. Display
// only; the whole text is rendered by the server.

// private-use marks that hold a code span or an escaped character
// while the rest is stripped, so neither is read as Markdown
const OPEN = "";
const SHUT = "";
const HELD = new RegExp(`${OPEN}(\\d+)${SHUT}`, "g");

// what opens a line: headings, quotes, bullets, numbers, task boxes
const BLOCK = /^(?:#{1,6}(?:\s+|$)|>\s?|[-*+]\s+|\d{1,9}[.)]\s+|\[[ xX]\]\s+)/;

// a fence's info string never holds a backtick, else it is inline code
const FENCE = /^(?:`{3,}[^`]*|~{3,}.*)$/;

export function plainLine(text: string): string {
  for (const part of text.split(/\r?\n/)) {
    const line = plainOf(part.trim());
    if (line !== "") return line;
  }
  return "";
}

function plainOf(text: string): string {
  let line = text;
  for (let was = ""; was !== line; ) {
    was = line;
    line = line.replace(BLOCK, "").trimStart();
  }
  if (FENCE.test(line)) return "";
  // a closing run of heading hashes
  line = line.replace(/\s+#+\s*$/, "");
  const held: string[] = [];
  const hold = (value: string) => `${OPEN}${held.push(value) - 1}${SHUT}`;
  // one pass, left to right: an escaped backtick opens no code span,
  // and a backslash inside a code span is kept
  line = line
    .replace(
      /\\([!-/:-@[-`{-~])|(`+)(.+?)\2/g,
      (_, ch: string | undefined, _ticks: string, code: string) =>
        hold(ch ?? code.trim()),
    )
    // images and links keep their words, autolinks their address
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
    .replace(/(\*\*\*|___)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "$1")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    // an underscore inside a word is no emphasis, as in snake_case
    .replace(
      /(^|[^\p{L}\p{N}_])_(\S(?:.*?\S)?)_(?=$|[^\p{L}\p{N}_])/gu,
      "$1$2",
    );
  return line
    .replace(HELD, (_, at: string) => held[Number(at)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
