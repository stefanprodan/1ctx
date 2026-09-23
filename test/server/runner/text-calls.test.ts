// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  dropTextCalls,
  TEXT_CALL_LINE,
} from "../../../src/server/runner/text-calls.ts";

const recorded = await Bun.file(
  "test/fixtures/runner/text-call-reply.txt",
).text();

describe("dropTextCalls", () => {
  test("keeps the words before a recorded call written as text", () => {
    expect(dropTextCalls(recorded)).toBe(
      "I have the namespace list already. Let me query the workload-bearing resources now.",
    );
  });

  test("answers the stop line when the reply is only a call", () => {
    for (const call of [
      '<tool_call>\n{"name": "bash"}\n</tool_call>',
      "<function=bash>\n<parameter=command>ls</parameter>\n</function>",
      '<|tool_call_begin|>bash{"command":"ls"}',
      '[TOOL_CALLS][{"name": "bash"}]',
    ]) {
      expect(dropTextCalls(`  \n${call}`)).toBe(TEXT_CALL_LINE);
    }
  });

  test("cuts at the first of several openers", () => {
    expect(dropTextCalls("Done.\n[TOOL_CALLS] x <tool_call> y")).toBe("Done.");
  });

  test("leaves a prose answer alone", () => {
    expect(dropTextCalls("The cache runs 10 pods, all ready.")).toBeNull();
  });
});
