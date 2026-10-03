// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where a streaming reply may be cut for a render. Rendered markdown is
// usually shorter than the raw text it replaces, so cutting inside a
// block makes the text jump; only whole top-level blocks are rendered
// and the rest stays a raw tail.

// a marker or quote may sit before a fence, as in "1. ```sh"
const FENCE_OPEN =
  /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]?)*)(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t]*(?:>[ \t]?)*(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// a marker, its space and a word: a lone "- " may yet be an underline
const ITEM_START = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/;
const MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]*)/;
// "* * *" is a rule, not an item; "---" under a paragraph is an underline
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// CommonMark lets a list interrupt a paragraph only with a non-empty
// item, and an ordered one only when it starts at 1
const INTERRUPTS = /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/;
const HEADING = /^#{1,6}(?:[ \t]|$)/;
const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;
const BLANK = /^[ \t]*$/;
const QUOTE = /^ {0,3}>/;
// the first characters of a line that may yet turn out a list item, or
// blank: a lone \r is half of a CRLF
const MAYBE_ITEM = /^[ \t\r\d*+-]/;

// a list or an indented code block goes on past a blank line, so its
// end is known only when the next block's first line starts
type Block = "none" | "list" | "indented" | "other";

// the column an item's text starts at; a line indented to it or more
// is inside the item, a marker left of it starts a sibling
function itemText(line: string): number {
  const m = MARKER.exec(line);
  if (m === null) return 0;
  const gap = (m[3] ?? "").replace(/\t/g, "    ").length;
  const blank = line.length === m[0].length;
  const lead = indent(m[1] ?? "") + (m[2] ?? "").length;
  return lead + (blank || gap < 1 || gap > 4 ? 1 : gap);
}

function indent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

// a table row's cells, outer pipes optional; a pipe after an odd run
// of backslashes is escaped. The renderer counts space after a header's
// last pipe as a cell but trims a delimiter row, so the caller trims
function cells(line: string): string[] {
  const parts: string[] = [];
  let cell = "";
  let slashes = 0;
  for (const ch of line.trimStart()) {
    if (ch === "|" && slashes % 2 === 0) {
      parts.push(cell);
      cell = "";
    } else cell += ch;
    slashes = ch === "\\" ? slashes + 1 : 0;
  }
  parts.push(cell);
  if (parts[0]?.trim() === "") parts.shift();
  if (parts.length > 0 && parts.at(-1) === "") parts.pop();
  return parts;
}

// the row under a table's header that makes it one: as many cells
function delimits(header: string, line: string): boolean {
  if (!line.includes("|")) return false;
  const row = cells(line.trimEnd());
  return (
    row.length > 0 &&
    row.length === cells(header).length &&
    row.every((cell) => DELIMITER_CELL.test(cell))
  );
}

// a tail of a marker and spaces and more of it may yet be a rule
function mayBeRule(rest: string): boolean {
  const text = rest.trim();
  const mark = text[0];
  if (mark !== "-" && mark !== "*" && mark !== "_") return false;
  return [...text].every((ch) => ch === mark || ch === " " || ch === "\t");
}

// past a blank line, a list goes on with a marker or a line indented to
// its item's text
function continues(block: Block, line: string, items: number): boolean {
  if (block === "list") return indent(line) >= items || LIST_ITEM.test(line);
  return indent(line) >= 4;
}

// The offset just after the last complete top-level block: a blank line
// outside a fence, a top-level fence's closing or whole line, or a
// heading line. A list or an indented code block ends only at the next
// block's first line. Parts that render the same alone are ends too:
// each whole line of an open fence, each row of a table from its
// delimiter row on, and the start of each item at the list's own level.
export function stableEnd(content: string): number {
  let end = 0;
  let block: Block = "none";
  // the end a list or indented code reaches if the next line ends it
  let pending: number | null = null;
  let fence: { char: string; length: number; top: boolean } | null = null;
  // the column the list's current item's text starts at
  let items = 0;
  // the first line of a paragraph that may be a table's header, and
  // whether the delimiter row came
  let header: string | null = null;
  let table = false;
  let at = 0;
  while (at < content.length) {
    const nl = content.indexOf("\n", at);
    if (nl === -1) {
      const rest = content.slice(at);
      if (pending !== null && fence === null && !MAYBE_ITEM.test(rest)) {
        end = pending;
      }
      // a marker and its space already start the next item or a break
      if (
        fence === null &&
        block === "list" &&
        ITEM_START.test(rest) &&
        !mayBeRule(rest) &&
        indent(rest) < items
      ) {
        end = at;
      }
      break;
    }
    const start = at;
    const next = nl + 1;
    const line = content.slice(at, content[nl - 1] === "\r" ? nl - 1 : nl);
    at = next;
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (fence.top) end = next;
      if (
        close !== undefined &&
        close[0] === fence.char &&
        close.length >= fence.length
      ) {
        if (fence.top) block = "none";
        fence = null;
      }
      continue;
    }
    if (BLANK.test(line)) {
      if (block === "list" || block === "indented") pending = next;
      else if (pending === null) {
        end = next;
        block = "none";
      }
      continue;
    }
    if (pending !== null) {
      if (!continues(block, line, items)) {
        end = pending;
        block = "none";
      }
      pending = null;
    }
    // the renderer reads every line of a table as a row, a heading or a
    // fence line too, until a blank line, a rule, a quote, indented
    // code or a list ends it
    if (table && block === "other") {
      if (RULE.test(line)) {
        end = next;
        block = "none";
        table = false;
        continue;
      }
      if (!QUOTE.test(line) && indent(line) < 4 && !LIST_ITEM.test(line)) {
        end = next;
        continue;
      }
      end = start;
      block = "none";
    }
    // a rule indented to an item's text is inside the item
    const rule =
      RULE.test(line) &&
      (block === "list"
        ? indent(line) < items
        : block !== "other" || line.trim()[0] !== "-");
    if (rule) {
      end = next;
      block = "none";
      continue;
    }
    if (HEADING.test(line)) {
      end = next;
      block = "none";
      continue;
    }
    if (block === "other" && INTERRUPTS.test(line)) {
      block = "list";
      items = itemText(line);
    } else if (block === "none") {
      block =
        LIST_ITEM.test(line) && indent(line) < 4
          ? "list"
          : indent(line) >= 4
            ? "indented"
            : "other";
      items = itemText(line);
      header =
        block === "other" &&
        line.includes("|") &&
        !QUOTE.test(line) &&
        !delimits(line, line)
          ? line
          : null;
      table = false;
    } else if (block === "other" && header !== null && !table) {
      table = delimits(header, line);
      header = null;
    }
    if (table && block === "other") end = next;
    if (block === "list" && LIST_ITEM.test(line) && indent(line) < items) {
      end = start;
      items = itemText(line);
    }
    if (block === "indented") continue;
    // past three spaces a fence line under a paragraph is its text
    if (block !== "list" && indent(line) >= 4) continue;
    const open = FENCE_OPEN.exec(line);
    const run = open?.[2];
    if (run !== undefined && !(run[0] === "`" && open?.[3]?.includes("`"))) {
      fence = {
        char: run[0] ?? "`",
        length: run.length,
        // a quote goes on past its fence, a list item past a blank line
        top: block !== "list" && !/[^ \t]/.test(open?.[1] ?? ""),
      };
    }
  }
  return end;
}
