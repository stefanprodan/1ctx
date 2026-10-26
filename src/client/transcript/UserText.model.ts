// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user message's text split into plain runs and fenced code blocks,
// the one piece of markdown a user message draws: a run's first
// message carries a check answer in a fence. Fences follow CommonMark:
// three or more backticks indented at most three spaces open one, a
// line of at least as many backticks closes it, and an unclosed fence
// runs to the end.

export type UserPart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; lang: string };

const OPEN = /^( {0,3})(`{3,})([^`]*)$/;
const CLOSE = /^ {0,3}(`{3,})[ \t]*$/;

export function userParts(text: string): UserPart[] {
  const lines = text.split("\n");
  const parts: UserPart[] = [];
  let plain: string[] = [];
  let i = 0;
  const flush = (beforeFence: boolean) => {
    // the line break next to a fence is the block's gap, not a blank line
    if (parts.length > 0 && plain[0]?.trim() === "") plain.shift();
    if (beforeFence && plain.at(-1)?.trim() === "") plain.pop();
    if (plain.length > 0) parts.push({ kind: "text", text: plain.join("\n") });
    plain = [];
  };
  while (i < lines.length) {
    const open = OPEN.exec(stripCr(lines[i] ?? ""));
    if (!open) {
      plain.push(lines[i] ?? "");
      i++;
      continue;
    }
    flush(true);
    const indent = open[1]?.length ?? 0;
    const ticks = open[2]?.length ?? 3;
    const code: string[] = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      const line = stripCr(lines[i] ?? "");
      i++;
      const close = CLOSE.exec(line);
      if (close && (close[1]?.length ?? 0) >= ticks) {
        closed = true;
        break;
      }
      code.push(dedent(line, indent));
    }
    // an unclosed fence at the end of a text that ends in a line break
    if (!closed && code.at(-1) === "") code.pop();
    parts.push({ kind: "code", text: code.join("\n"), lang: lang(open[3]) });
  }
  if (parts.length === 0) return [{ kind: "text", text }];
  flush(false);
  return parts;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

// a fence indented by n spaces takes up to n spaces off each line
function dedent(line: string, n: number): string {
  let cut = 0;
  while (cut < n && line[cut] === " ") cut++;
  return line.slice(cut);
}

// only a plain word names a language; the rest of an info string is not
// drawn
function lang(info: string | undefined): string {
  const word = (info ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\w+#.-]{1,24}$/.test(word) ? word.toLowerCase() : "";
}
