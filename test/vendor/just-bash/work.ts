// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Work counted rather than timed, for the tests that keep a path linear:
// what a quadratic bug repeats shows in the counts on any runner.

import { expect } from "bun:test";

// characters read one at a time, and steps over maps, sets and arrays
export type Work = { chars: number; steps: number };

type Next = (this: unknown) => IteratorResult<unknown>;

// Patches globals, so only from a test.serial.
export async function countWork<T>(
  body: () => Promise<T>,
): Promise<{ result: T; work: Work }> {
  const work: Work = { chars: 0, steps: 0 };
  const charCodeAt = String.prototype.charCodeAt;
  const slice = Array.prototype.slice;
  const mapEach = Map.prototype.forEach;
  const setEach = Set.prototype.forEach;
  const iterators: { next: Next }[] = [new Map(), new Set(), []].map((each) =>
    Object.getPrototypeOf(each[Symbol.iterator]()),
  );
  const nexts = iterators.map((proto) => proto.next);
  String.prototype.charCodeAt = function (this: string, index: number) {
    work.chars++;
    return charCodeAt.call(this, index);
  };
  Array.prototype.slice = function (this: unknown[], ...args) {
    const copy = slice.apply(this, args);
    work.steps += copy.length;
    return copy;
  };
  Map.prototype.forEach = function (this: Map<unknown, unknown>, ...args) {
    work.steps += this.size;
    return mapEach.apply(this, args);
  };
  Set.prototype.forEach = function (this: Set<unknown>, ...args) {
    work.steps += this.size;
    return setEach.apply(this, args);
  };
  iterators.forEach((proto, i) => {
    proto.next = function (this: unknown) {
      work.steps++;
      return nexts[i]!.call(this);
    };
  });
  try {
    return { result: await body(), work };
  } finally {
    String.prototype.charCodeAt = charCodeAt;
    Array.prototype.slice = slice;
    Map.prototype.forEach = mapEach;
    Set.prototype.forEach = setEach;
    iterators.forEach((proto, i) => {
      proto.next = nexts[i]!;
    });
  }
}

// Each count at 8 times the input: linear work grows about 8 times,
// quadratic 64.
export function expectLinear(
  small: Record<string, number>,
  large: Record<string, number>,
): void {
  for (const [kind, count] of Object.entries(large)) {
    expect(count, kind).toBeLessThan(16 * Math.max(1, small[kind] ?? 0));
  }
}
