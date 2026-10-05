// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { cutAt } from "../../shared/text.ts";
import { tokens } from "../lib/tokens.ts";
import type { ToolCall } from "../providers/index.ts";
import type { ToolResult } from "./policy.ts";

export const CONTEXT_CUT = "result cut to fit the context";

// a tool's end as its row stores it: fields by name, so one the log
// keeps, like ended, never reaches the row
export function toolFinish(result: ToolResult, now: number) {
  return {
    content: result.content,
    status: result.error ? ("failed" as const) : ("done" as const),
    error: result.error ? result.content : null,
    finishedAt: now,
    opened: result.opened,
    saved: result.saved,
  };
}

export function cutResult(result: ToolResult, chars: number): ToolResult {
  if (result.content.length <= chars) return result;
  const tail = result.tail ?? 0;
  if (tail > chars) throw new Error("the result tail exceeds the result limit");
  return {
    ...result,
    content:
      cutAt(result.content, chars - tail) +
      result.content.slice(result.content.length - tail),
  };
}

export function resultsFit(
  calls: ToolCall[],
  chars: number,
  room: number | null,
): boolean {
  if (room === null) return true;
  // A six-byte bound per UTF-16 unit lets roomy rounds store each end at once.
  const bound = calls.reduce(
    (sum, call) =>
      sum +
      chars * 6 +
      new TextEncoder().encode(
        JSON.stringify({ role: "tool", tool_call_id: call.id, content: "" }),
      ).byteLength,
    0,
  );
  return bound <= room;
}

export function fitResults(
  calls: ToolCall[],
  results: ToolResult[],
  room: number | null,
): { results: ToolResult[]; cut: boolean } {
  if (room === null) return { results, cut: false };
  const count = (index: number, content: string) =>
    tokens(
      JSON.stringify({
        role: "tool",
        tool_call_id: calls[index]!.id,
        content,
      }),
    );
  const sizes = results.map((result, i) => count(i, result.content));
  let total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= room) return { results, cut: false };
  const fitted = results.slice();
  const order = sizes
    .map((size, index) => ({ size, index }))
    .sort((a, b) => b.size - a.size || a.index - b.index);
  for (const { size, index } of order) {
    if (total <= room) break;
    const result = results[index]!;
    const tail = result.content.slice(
      result.content.length - (result.tail ?? 0),
    );
    const body = result.content.slice(0, result.content.length - tail.length);
    const ending = `${tail === "" ? "" : `\n${tail}`}\n${CONTEXT_CUT}`;
    const target = Math.max(0, size - (total - room));
    let kept = "";
    let keptSize = count(index, ending);
    if (keptSize >= size) continue;
    let low = 0;
    let high = body.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = cutAt(body, mid);
      const candidateSize = count(index, candidate + ending);
      if (candidateSize <= target) {
        kept = candidate;
        keptSize = candidateSize;
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    fitted[index] = {
      ...result,
      content: kept + ending,
      tail: ending.length,
    };
    total += keptSize - size;
  }
  return { results: fitted, cut: true };
}
