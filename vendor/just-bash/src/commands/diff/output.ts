/**
 * (1ctx) How diff writes one line of a file: its mark, a space or with -T
 * a tab, the text, and GNU's words after a line with no newline.
 */

import type { Lines } from "./lines.js";

export interface LineStyle {
  /** -T: a tab after the mark instead of the space */
  initialTab: boolean;
  /** --suppress-blank-empty: no blank after the mark of an empty line */
  suppressBlankEmpty: boolean;
  /** -t: tabs expanded to spaces at this size, 0 to keep them */
  expandTabs: number;
}

export const NO_NEWLINE = "\\ No newline at end of file\n";

/** Tabs to spaces, counting one column per character. */
export function expandTabs(text: string, size: number): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const spaces = size - (column % size);
      out += " ".repeat(spaces);
      column += spaces;
    } else {
      out += ch;
      column++;
    }
  }
  return out;
}

/**
 * Writes line `i` of `file` after `mark`. `gap` is what separates them
 * (" " in the normal and context formats, "" in unified), and a context
 * line of unified has the mark " ".
 */
export function writeLine(
  out: string[],
  mark: string,
  gap: string,
  file: Lines,
  i: number,
  style: LineStyle,
): void {
  let text = file.lines[i];
  if (style.expandTabs > 0) text = expandTabs(text, style.expandTabs);
  let lead: string;
  if (text === "" && style.suppressBlankEmpty) lead = mark.trimEnd();
  else if (style.initialTab) lead = `${mark === " " && gap === "" ? "" : mark}\t`;
  else lead = mark + gap;
  out.push(lead, text, "\n");
  if (i === file.lines.length - 1 && file.incomplete) out.push(NO_NEWLINE);
}
