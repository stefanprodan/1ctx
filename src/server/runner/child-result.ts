// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a delegate call gives back: the child's answer, cut, and the
// files its /tmp returned to the parent's, as the result's tail so every
// later cut keeps them. The child's session id goes on the tool row,
// never in the text.

import { cutAt } from "../../shared/text.ts";
import type { SendCause } from "../../shared/words.ts";
import type { ToolResult } from "./policy.ts";

export type ChildEnd = {
  cause: SendCause;
  error: string | null;
  // the done answer, null when the child gave none
  answer: string | null;
  // the last words it wrote, for a result that failed
  last: string;
  folder: string;
  // the parent's paths, and the child's ones that did not fit
  copied: readonly string[];
  left: readonly string[];
};

const MORE = (n: number, folder: string) => `and ${n} more in /tmp/${folder}/`;

// one path a line while they fit in room, then how many more
function listed(
  lines: readonly string[],
  room: number,
  more: (n: number) => string,
): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const rest = lines.length - i - 1;
    const reserve = rest > 0 ? more(rest).length + 1 : 0;
    if (used + line.length + 1 + reserve > room) {
      out.push(more(lines.length - i));
      return out;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

// the files part, at most a quarter of the cut, so the answer always shows
function filesTail(end: ChildEnd, resultCut: number): string {
  if (end.copied.length === 0 && end.left.length === 0) return "";
  const room = Math.floor(resultCut / 4);
  const parts: string[] = [];
  if (end.copied.length > 0) {
    parts.push(
      `Files in /tmp/${end.folder}/:`,
      ...listed(end.copied, room / 2, (n) => MORE(n, end.folder)),
    );
  }
  if (end.left.length > 0) {
    parts.push(
      "Not copied, past this chat's /tmp limits:",
      ...listed(end.left, room / 2, (n) => `and ${n} more`),
    );
  }
  return cutAt(parts.join("\n"), room);
}

function failure(end: ChildEnd): string | null {
  if (end.cause === "finish") {
    return end.answer === null || end.answer.trim() === ""
      ? "The subagent gave no answer."
      : null;
  }
  if (end.cause === "deadline") return "The subagent ran out of time.";
  if (end.cause === "failure") {
    return `The subagent failed: ${end.error ?? "unknown error"}.`;
  }
  return "The subagent was stopped.";
}

export function childResult(
  end: ChildEnd,
  caps: { answerChars: number; resultCut: number },
): ToolResult {
  const files = filesTail(end, caps.resultCut);
  const tail = files === "" ? "" : `\n\n${files}`;
  const room = Math.min(caps.answerChars, caps.resultCut - tail.length);
  const failed = failure(end);
  const body =
    failed === null
      ? cutAt(end.answer!.trim(), room)
      : end.last.trim() === ""
        ? cutAt(failed, room)
        : cutAt(`${failed} Its last words:\n${end.last.trim()}`, room);
  return {
    content: body + tail,
    error: failed !== null,
    ...(tail === "" ? {} : { tail: tail.length }),
  };
}
