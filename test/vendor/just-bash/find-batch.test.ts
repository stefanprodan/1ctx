// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A walker that fails part way through a batch of reads waits for the
// rest of the batch before it returns, so no read rejects after the
// command, where the defense-in-depth box makes it an unhandled rejection
// that can end the worker. find's case is upstream's #451 test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

// taken before any command runs: the box blocks the global during one
const hostSetTimeout = setTimeout;
const pause = (ms: number) =>
  new Promise<void>((resolve) => hostSetTimeout(resolve, ms));

// directory reads take real time, as a disk's do; a path named late
// resolves later than the others
class SlowFs extends InMemoryFs {
  override async readdir(path: string): Promise<string[]> {
    await pause(20);
    return super.readdir(path);
  }

  override async readdirWithFileTypes(
    path: string,
  ): ReturnType<InMemoryFs["readdirWithFileTypes"]> {
    await pause(20);
    return super.readdirWithFileTypes(path);
  }

  override async realpath(path: string): Promise<string> {
    await pause(path.includes("late") ? 50 : 1);
    return super.realpath(path);
  }
}

function tree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let d = 0; d < 30; d++)
    for (let f = 0; f < 50; f++) files[`/t/d${d}/f${f}`] = "";
  return files;
}

describe("a walker failing part way through a batch", () => {
  const unhandled: unknown[] = [];
  const record: NodeJS.UnhandledRejectionListener = (reason) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", record);
  });

  afterEach(() => {
    // bun-types type off() for "memoryPressure" alone
    (process as NodeJS.EventEmitter).off("unhandledRejection", record);
  });

  // the root settles at 20ms and its thirty children are in flight until
  // about 40ms; each case ends the command inside that window
  const cases: [string, object, number | undefined, number][] = [
    [
      "a traversal limit",
      { maxTraversalEntries: 500, maxTraversalWork: 500 },
      undefined,
      126,
    ],
    ["an abort", {}, 30, 124],
    ["the execution deadline", { maxExecutionTimeMs: 30 }, undefined, 124],
  ];
  for (const [reason, executionLimits, abortAfterMs, exitCode] of cases)
    test.serial(`find leaves nothing to reject after ${reason}`, async () => {
      const bash = new Bash({ fs: new SlowFs(tree()), executionLimits });
      const controller = new AbortController();
      if (abortAfterMs !== undefined)
        hostSetTimeout(() => controller.abort(), abortAfterMs);
      const result = await bash.exec("find /t -type f", {
        signal: controller.signal,
      });
      await pause(200);
      expect(result.exitCode).toBe(exitCode);
      expect(unhandled).toEqual([]);
    });

  test.serial("[ -ef ] waits for both sides", async () => {
    const bash = new Bash({ fs: new SlowFs({}) });
    const result = await bash.exec("[ /early -ef /late ]");
    await pause(200);
    expect(result.exitCode).toBe(1);
    expect(unhandled).toEqual([]);
  });
});
