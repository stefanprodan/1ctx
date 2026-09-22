// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A fixed window per key, in memory: the login route's guard. One
// counter and one timestamp per key, so a flood costs nothing to keep
// blocked, and a cap on keys so a flood of addresses cannot grow the
// map without bound. Pure over the clock it is given.

export const MAX_KEYS = 10_000;

type Window = { start: number; count: number };

export class RateLimit {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // true when the hit is allowed; the hit is counted either way so a
  // flood keeps the key blocked until its window ends
  hit(key: string, now: number): boolean {
    let w = this.windows.get(key);
    if (w === undefined || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      // re-insert so the map's order is by window start, oldest first
      this.windows.delete(key);
      this.windows.set(key, w);
    }
    w.count++;
    if (this.windows.size > MAX_KEYS) this.evict(now);
    return w.count <= this.limit;
  }

  // true for the one refused hit that closed the key's window, so a
  // caller can report the closing once rather than every refusal
  closed(key: string): boolean {
    return this.windows.get(key)?.count === this.limit + 1;
  }

  get size(): number {
    return this.windows.size;
  }

  // drop the windows that ended, at most once a window; past the cap
  // regardless, drop the oldest, which forgets a key's count early and
  // never blocks one that should pass
  private evict(now: number): void {
    if (now - this.lastSweep >= this.windowMs) {
      this.lastSweep = now;
      for (const [key, w] of this.windows) {
        if (now - w.start >= this.windowMs) this.windows.delete(key);
      }
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size <= MAX_KEYS) break;
      this.windows.delete(key);
    }
  }
}
