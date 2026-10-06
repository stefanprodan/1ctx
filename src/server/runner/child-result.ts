// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a delegate call gives back: the child's answer, cut, and the
// files its /tmp returned to the parent's, as the result's tail so every
// later cut keeps them. The child's session id goes on the tool row,
// never in the text.

import { filesHeading, NOT_COPIED } from "../../shared/subagents.ts";
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

// the tail, its blank line included, at most this: with an answer at
// childAnswerChars' ceiling it fits the transcript's display cut
// (RESULT_DISPLAY_CHARS), which the client reads the files part from
export const TAIL_CHARS = 4_000;
const SEPARATOR = "\n\n";

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

// the files part, headings counted, at most a quarter of the cut, so the
// answer always shows, and at most TAIL_CHARS; each group gets an even
// share
function filesTail(end: ChildEnd, resultCut: number): string {
  const groups = [
    {
      head: filesHeading(end.folder),
      lines: end.copied,
      more: (n: number) => MORE(n, end.folder),
    },
    {
      head: NOT_COPIED,
      lines: end.left.map((path) => `/tmp/${path}`),
      more: (n: number) => `and ${n} more`,
    },
  ].filter((group) => group.lines.length > 0);
  if (groups.length === 0) return "";
  const room = Math.min(
    Math.floor(resultCut / 4),
    TAIL_CHARS - SEPARATOR.length,
  );
  // the newline between the groups
  const share = Math.floor((room - (groups.length - 1)) / groups.length);
  const parts = groups.flatMap((group) => [
    group.head,
    ...listed(group.lines, share - group.head.length - 1, group.more),
  ]);
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
  const tail = files === "" ? "" : `${SEPARATOR}${files}`;
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
