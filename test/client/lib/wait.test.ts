// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// How long a waiting body stays: a load that lands before the reveal
// never held anything, one that showed its bones keeps them SHOW_MS past
// the reveal, and a load starting again while they are held keeps them
// counted as shown. Every step is on a fake clock.

import { describe, expect, test } from "bun:test";
import {
  idleHold,
  REVEAL_MS,
  SHOW_MS,
  setWaitClock,
  stepHold,
} from "../../../src/client/lib/wait.ts";

// the steps a page's renders take, each at its time
function run(steps: [loading: boolean, at: number][]): boolean[] {
  let hold = idleHold;
  return steps.map(([loading, at]) => {
    const step = stepHold(hold, loading, at);
    hold = step.hold;
    return step.waiting;
  });
}

describe("the wait's hold", () => {
  test("waits while loading, and never before a load", () => {
    expect(run([[false, 0]])).toEqual([false]);
    expect(
      run([
        [true, 0],
        [true, 50],
      ]),
    ).toEqual([true, true]);
  });

  test("a load that lands before the reveal holds nothing", () => {
    expect(
      run([
        [true, 1000],
        [false, 1000 + REVEAL_MS - 1],
      ]),
    ).toEqual([true, false]);
  });

  test("bones that showed stay SHOW_MS past the reveal", () => {
    const start = 1000;
    const end = start + REVEAL_MS + SHOW_MS;
    expect(
      run([
        [true, start],
        [false, start + REVEAL_MS + 10],
        [false, end - 1],
        [false, end],
      ]),
    ).toEqual([true, true, true, false]);
  });

  test("a load that ran past the hold lets go at once", () => {
    expect(
      run([
        [true, 0],
        [false, REVEAL_MS + SHOW_MS + 1],
      ]),
    ).toEqual([true, false]);
  });

  test("a load again while held counts the bones as shown", () => {
    // held until 500; it starts again at 300 and lands at 310, its
    // reveal counted as already past, so it holds SHOW_MS from there
    expect(
      run([
        [true, 0],
        [false, REVEAL_MS + 10],
        [true, REVEAL_MS + 100],
        [false, REVEAL_MS + 110],
        [false, REVEAL_MS + 100 + SHOW_MS - 1],
        [false, REVEAL_MS + 100 + SHOW_MS],
      ]),
    ).toEqual([true, true, true, true, true, false]);
  });

  test("the clock is the caller's to replace", () => {
    const fake = { now: () => 0, after: () => () => {} };
    const was = setWaitClock(fake);
    expect(setWaitClock(was)).toBe(fake);
  });
});
