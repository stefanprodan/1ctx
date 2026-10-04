// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cells, summarize, table } from "../../../scripts/load/summarize.ts";

const RUN = join(import.meta.dir, "../../fixtures/load/run-a");

describe("the summarizer", () => {
  test("reads a run's logs into one row", async () => {
    const row = await summarize(RUN);
    expect(row.label).toBe("run-a");
    expect(row.target).toBe("local");
    expect(row.mode).toBe("turns");
    expect(row.turns).toEqual({ done: 3, failed: 1 });
    // round 1 asked 250 ms after round 0 ended, less its 200 ms MCP call
    expect(row.gapMs.n).toBe(1);
    expect(row.gapMs.p50).toBe(50);
    // a turn's first request against its post
    expect(row.firstRequestMs.n).toBe(2);
    expect(row.firstRequestMs.max).toBe(300);
    // a second request for a round is a compaction, not a gap
    expect(row.compactions).toBe(1);
    expect(row.commandErrors).toBe(2);
    expect(row.mcpCalls).toBe(2);
    expect(row.refused).toBe(2);
    expect(row.serverErrors).toBe(1);
    expect(row.toolFailed).toEqual({ "bash run deadline": 1 });
    expect(row.cpuM.max).toBe(900);
    expect(row.memMi.max).toBe(320);
    expect(row.probe.feed.p95).toBe(9);
    expect(row.feedRefreshMs.p95).toBe(40);
  });

  test("prints one table row per run", async () => {
    const row = await summarize(RUN);
    const lines = table([row]).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`| ${cells(row).join(" | ")} |`);
    expect(cells(row)[5]).toBe("20.0 / 30.0");
  });
});
