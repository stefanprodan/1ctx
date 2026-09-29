// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command that ran but whose changes cannot be saved still returns
// what it printed, then the refusal and the exit, through the real
// command path.

import { describe, expect, test } from "bun:test";
import {
  afterMountRead,
  callCaps,
  run,
  scratchState,
  setup,
} from "./helpers.ts";

describe("a refused save keeps the command's output", () => {
  test("a /knowledge name outside the rule", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "echo before; echo oops >&2; echo x > '/knowledge/my notes.md'",
      );
      expect(result.error).toBe(true);
      expect(result.content).toStartWith("before\noops\n\nnothing saved: ");
      expect(result.content).toContain("path segments");
      expect(result.content).toEndWith("\nexit 0");
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("the scratch file cap", async () => {
    const s = setup({ scratchFiles: 10 });
    try {
      const result = await run(
        s,
        "for i in $(seq 11); do touch /tmp/f$i; done; echo made 11",
      );
      expect(result).toMatchObject({
        content:
          "made 11\n\nnothing saved: the scratch would have 11 files, the limit is 10\nexit 0",
        error: true,
      });
      expect(result.tail).toBe(
        "nothing saved: the scratch would have 11 files, the limit is 10\nexit 0"
          .length,
      );
      expect(scratchState(s).files).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test("the scratch byte cap", async () => {
    const s = setup({ scratchBytes: 100 });
    try {
      const result = await run(s, "seq 1 100 > /tmp/big; wc -l < /tmp/big");
      expect(result.error).toBe(true);
      expect(result.content).toStartWith("100\n\nnothing saved: the scratch ");
      expect(result.content).toEndWith("\nexit 0");
      expect(scratchState(s).files).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test("a file changed by someone else meanwhile", async () => {
    const s = setup();
    try {
      const file = s.knowledge.create(s.projectId, s.author, "x.md", "one");
      afterMountRead(s, () =>
        s.knowledge.store.replace(file, s.author, "racing", 101),
      );
      const result = await run(
        s,
        "echo edit > x.md; echo partial > second; grep -c . x.md; false",
      );
      expect(result.error).toBe(true);
      expect(result.content).toBe(
        "1\n\nnothing saved: x.md changed while the command ran, read it again\nexit 1",
      );
      expect(s.knowledge.store.byName(s.projectId, "second")).toBeNull();
      expect(s.knowledge.store.byName(s.projectId, "x.md")?.text).toBe(
        "racing",
      );
    } finally {
      s.db.close();
    }
  });

  test("the result cut bounds the output and keeps the refusal", async () => {
    const s = setup({ scratchFiles: 1 });
    try {
      const result = await run(s, "seq 1 5000; touch /tmp/a /tmp/b", {
        ...callCaps,
        resultCut: 300,
      });
      const tail =
        "nothing saved: the scratch would have 2 files, the limit is 1\nexit 0";
      expect(result.error).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(300);
      expect(result.content).toStartWith("1\n2\n");
      expect(result.content).toContain("... output cut at 300 characters");
      expect(result.content).toEndWith(tail);
      expect(result.tail).toBe(tail.length);
      expect(scratchState(s).files).toBe(0);
    } finally {
      s.db.close();
    }
  });
});
