// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { finishWords } from "../../src/shared/finish.ts";

describe("finishWords", () => {
  test.each([
    [null, null, null],
    ["", null, null],
    ["stop", null, null],
    ["stop", "end_turn", null],
    ["stop/eos", null, null],
    ["tool_calls", null, null],
    ["tool_repeat", null, null],
    ["length", null, "cut at max tokens"],
    ["length", "max_output_tokens", "cut at max tokens (max_output_tokens)"],
    ["length/max", null, "cut at max tokens"],
    ["tool_text", "stop", "tool call dropped"],
    ["content_filter", null, "cut by the provider's filter"],
    ["content_filter", "SAFETY", "cut by the provider's filter (SAFETY)"],
    ["error", null, "ended by a provider error"],
    ["error", "overloaded", "ended by a provider error (overloaded)"],
    ["recitation", null, "ended: recitation"],
  ] as [string | null, string | null, string | null][])(
    "%p with native %p",
    (reason, native, words) => {
      expect(finishWords(reason, native)).toBe(words);
    },
  );
});
