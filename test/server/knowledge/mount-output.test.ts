// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { run, setup } from "./helpers.ts";

describe("knowledge command output", () => {
  test("stdout then stderr is cut while Unicode, status and receipts stay intact", async () => {
    const s = setup();
    try {
      s.area.create(
        s.projectId,
        s.author,
        "text",
        "x\u00e9\ud83d\ude00".repeat(270),
      );
      const result = await run(s, "cat text; echo warning >&2; echo saved > x");
      expect(result).toMatchObject({ error: false });
      expect(result.content.length).toBeLessThanOrEqual(1000);
      expect(result.content.isWellFormed()).toBe(true);
      expect(result.content).toStartWith("x\u00e9\ud83d\ude00");
      expect(result.content).toContain(
        "... output cut at 1000 characters, narrow with grep or sed -n",
      );
      expect(result.content).toEndWith("exit 0\nwrote x (rev 1, 1 lines)");
      expect(result.tail).toBe("exit 0\nwrote x (rev 1, 1 lines)".length);
      const ordered = await run(s, "echo out; echo err >&2");
      expect(ordered.content).toBe("out\nerr\n\nexit 0");
      expect(ordered.tail).toBe(6);
    } finally {
      s.db.close();
    }
  });

  test("output budget limits and unreportable receipt sets never commit", async () => {
    const s = setup({ scratchBytes: 4000, knowledgeFileBytes: 4000 });
    try {
      expect((await run(s, "echo saved > x; seq 1 10000")).error).toBe(true);
      expect(s.area.list(s.projectId).files).toEqual([]);
      const result = await run(s, "for i in {1..100}; do touch file$i; done");
      expect(result.error).toBe(true);
      expect(result.content).toContain(
        "change receipts exceed 1000 characters",
      );
      expect(s.area.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });
});
