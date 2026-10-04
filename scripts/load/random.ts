// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Seeded randomness for the load harness. Everything a run or a build
// draws comes from these, so the same seed gives the same turns, files
// and databases.

export type Rand = () => number;

// mulberry32
export function rng(seed: number): Rand {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a with a murmur finaliser, so near keys spread
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// JSON with sorted keys, so equal arguments hash alike
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function pick<T>(r: Rand, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)]!;
}

export function int(r: Rand, a: number, b: number): number {
  return a + Math.floor(r() * (b - a + 1));
}

export function weighted<T>(r: Rand, mix: readonly (readonly [T, number])[]) {
  let total = 0;
  for (const [, w] of mix) total += w;
  let d = r() * total;
  for (const [value, w] of mix) {
    d -= w;
    if (d < 0) return value;
  }
  return mix[mix.length - 1]![0];
}

// a value from a cumulative table of [probability, value]
export function cumulative(
  r: Rand,
  table: readonly (readonly [number, number])[],
) {
  const draw = r();
  return (table.find(([p]) => draw < p) ?? table[table.length - 1]!)[1];
}

export function shuffle<T>(r: Rand, list: readonly T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
