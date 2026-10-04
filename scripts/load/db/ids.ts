// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Ids and seeds for a build: ids that look like the app's (12 of
// [0-9a-z]) but are a bijection of a counter, so they never collide and
// every build is the same, and a hash of numbers for per-row seeds.

import type { Rand } from "../random.ts";

const mixId = (v: number, k: number) => {
  let h = Math.imul(v ^ k, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return h & 0x7fffffff;
};
const b36 = (v: number) => v.toString(36).padStart(6, "0");

// a fresh counter per build, so two builds in one process agree
export function idMaker(): () => string {
  let counter = 0;
  return () => {
    const n = counter++;
    let l = n & 0x7fffffff;
    let r = Math.floor(n / 2 ** 31) & 0x7fffffff;
    for (let k = 0; k < 4; k++) {
      const t = r;
      r = l ^ mixId(r, k * 7919 + 0x1c7c);
      l = t;
    }
    return b36(l) + b36(r);
  };
}

export const hash = (...xs: number[]) => {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 0x01000193);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
    h ^= h >>> 13;
  }
  return h | 0;
};

// lognormal with the given mean
export function lognormal(r: Rand, mean: number, sigma: number): number {
  const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  return mean * Math.exp(sigma * z - (sigma * sigma) / 2);
}
