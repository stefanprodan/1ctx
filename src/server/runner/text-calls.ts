// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An answer asked for without schemas can only be text, and a model that
// still wants a tool writes the call in its own markup, which a server
// parses only when tools were offered. Such a reply keeps the words
// before the first call and drops the rest; one with no words left is
// the stop line.

const OPENERS = [
  "<tool_call>",
  "<function=",
  "<function_call>",
  "<|tool_call",
  "<|python_tag|>",
  "<|channel|>commentary to=",
  "[TOOL_CALLS]",
];

export const TEXT_CALL_LINE =
  "Stopped: the agent kept calling tools after it was asked to answer.";

// null when the text holds no call
export function dropTextCalls(text: string): string | null {
  const at = OPENERS.map((opener) => text.indexOf(opener))
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), Number.POSITIVE_INFINITY);
  if (at === Number.POSITIVE_INFINITY) return null;
  const kept = text.slice(0, at).trimEnd();
  return kept === "" ? TEXT_CALL_LINE : kept;
}
