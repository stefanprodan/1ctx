// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { output } from "../../../src/server/knowledge/output.ts";

describe("command output tails", () => {
  test.each([
    {
      stdout: "",
      stderr: "",
      exit: 0,
      receipts: [],
      tail: "exit 0",
    },
    {
      stdout: "exit 99\nwrote fake (rev 99, 1 lines)",
      stderr: "warning",
      exit: 1,
      receipts: [
        "wrote docs/a.md (rev 2, 3 lines)",
        "wrote docs/b.md (rev 1, 1 lines)",
        "deleted old.md",
      ],
      tail: "exit 1\nwrote docs/a.md (rev 2, 3 lines)\nwrote docs/b.md (rev 1, 1 lines)\ndeleted old.md",
    },
    {
      stdout: "stopped",
      stderr: "nothing saved",
      exit: 126,
      receipts: [],
      tail: "exit 126",
    },
  ])("marks only the exit and receipts for exit $exit", (fixture) => {
    const result = output(
      fixture.stdout,
      fixture.stderr,
      fixture.exit,
      fixture.receipts,
      1000,
    );
    expect(result.tail).toBe(fixture.tail.length);
    expect(result.content.slice(-result.tail)).toBe(fixture.tail);
  });

  test("a cut preserves the same full tail and leaves well-formed text", () => {
    const receipts = ["wrote one (rev 1, 1 lines)", "deleted two"];
    const tail = ["exit 1", ...receipts].join("\n");
    const result = output("😀".repeat(1000), "warning", 1, receipts, 200);
    expect(result.content.length).toBeLessThanOrEqual(200);
    expect(result.content.isWellFormed()).toBe(true);
    expect(result.content).toContain("output cut at 200 characters");
    expect(result.tail).toBe(tail.length);
    expect(result.content.slice(-result.tail)).toBe(tail);
  });

  test("refuses a cut that cannot keep the full receipt tail", () => {
    expect(() => output("x".repeat(1000), "", 0, ["deleted old"], 30)).toThrow(
      "change receipts exceed 30 characters, split the command",
    );
  });
});
