// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { after, type Clock } from "../../../src/server/lib/clock.ts";

// a clock whose sleeps the test rings by hand
function handClock() {
  const sleeps: { ring: () => void; signal: AbortSignal | undefined }[] = [];
  const clock: Clock = Object.assign(() => 0, {
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((ring) => {
        sleeps.push({ ring, signal });
      }),
  });
  return { clock, sleeps };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("after", () => {
  test("fires when the clock's sleep rings", async () => {
    const { clock, sleeps } = handClock();
    let fired = 0;
    after(clock, 1_000, () => fired++);
    expect(sleeps).toHaveLength(1);
    sleeps[0]!.ring();
    await flush();
    expect(fired).toBe(1);
  });

  test("a cancel aborts the sleep and never fires", async () => {
    const { clock, sleeps } = handClock();
    let fired = 0;
    const cancel = after(clock, 1_000, () => fired++);
    cancel();
    expect(sleeps[0]!.signal?.aborted).toBeTrue();
    // a clock that rings anyway reaches nothing
    sleeps[0]!.ring();
    await flush();
    expect(fired).toBe(0);
  });
});
