// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Highlighted HTML cut into lines. highlight.js answers one string whose
// spans may cross a newline (a block comment, a string); each line
// closes the spans still open at its end and the next reopens them, so
// every line is balanced HTML that draws on its own.

const TOKEN = /(<span\b[^>]*>)|(<\/span>)|(\r?\n)|([^<\r\n]+|<|\r)/g;

export function splitLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const m of html.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      open.push(m[1]);
      line += m[1];
    } else if (m[2] !== undefined) {
      // a stray close has nothing to balance: dropping it keeps the
      // line from closing a span of the page
      if (open.length === 0) continue;
      open.pop();
      line += m[2];
    } else if (m[3] !== undefined) {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      line += m[4];
    }
  }
  out.push(line + "</span>".repeat(open.length));
  return out;
}

// a text's lines as the page numbers them: a final newline ends the last
// line rather than starting an empty one
export function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
