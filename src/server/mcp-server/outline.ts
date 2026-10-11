// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { cutSearchLine } from "../../shared/search.ts";

type OutlineRow = { line: number; level: number; text: string };

export function outlineRows(text: string): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const [index, line] of text.split("\n").entries()) {
    if (fence !== null) {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*\r?$/);
      if (
        close !== null &&
        close[1]![0] === fence.marker &&
        close[1]!.length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening !== null) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    const heading = line.match(/^(#{1,6})(?:[ \t]+(.*)|[ \t]*)\r?$/);
    if (heading === null) continue;
    const headingText = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
    rows.push({
      line: index + 1,
      level: heading[1]!.length,
      text: cutSearchLine(headingText, index + 1, { from: 0, to: 0 }).text,
    });
  }
  return rows;
}
