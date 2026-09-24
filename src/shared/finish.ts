// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words under a reply that did not end on its own, for the
// transcript and the Markdown download alike. A stop the provider
// reports but no line explains would read as a finished answer.

// a normal end, or a cap of the loop's, which the work fold words
const ENDS = new Set([
  "stop",
  "tool_calls",
  "tool_limit",
  "token_limit",
  "context_limit",
  "tool_loop",
  "tool_repeat",
]);

// null when the reply ended normally; the upstream's own reason follows
// in parentheses when a router passed one on
export function finishWords(
  reason: string | null,
  native: string | null,
): string | null {
  if (reason === null || reason === "") return null;
  // a wire's details ride after a slash, as "stop/eos"
  const base = reason.split("/")[0]!;
  if (base === "tool_text") return "tool call dropped";
  const words =
    base === "length"
      ? "cut at max tokens"
      : base === "content_filter"
        ? "cut by the provider's filter"
        : base === "error"
          ? "ended by a provider error"
          : ENDS.has(base)
            ? null
            : `ended: ${base}`;
  if (words === null) return null;
  return native ? `${words} (${native})` : words;
}
