// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The driver's events, one JSON line each on stdout, which the
// summarizer reads back; and the percentiles every report uses.

export const MIN = 60_000;
export const now = () => Date.now();
export const sleep = (ms: number) => Bun.sleep(Math.max(0, ms));

export function out(event: Record<string, unknown>) {
  console.log(JSON.stringify(event));
}

export function info(msg: string, extra: Record<string, unknown> = {}) {
  out({ t: "info", at: now(), msg, ...extra });
}

export function failure(what: string, extra: Record<string, unknown> = {}) {
  out({ t: "error", at: now(), what, ...extra });
}

export type Stats = {
  n: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
};

export function stats(xs: readonly number[]): Stats {
  if (xs.length === 0) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) =>
    Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
  return {
    n: s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: Math.round(s.at(-1)!),
  };
}

// a small worker pool: n at once over the items, in order
export async function pool<T>(
  items: readonly T[],
  n: number,
  fn: (x: T, i: number) => Promise<unknown>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}
