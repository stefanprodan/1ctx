// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One first-page load of a list at a time. A warm ask while a load is
// out, or in the pause after one lands, becomes the one trailing load,
// run once the pause ends: a burst of asks costs the server at most the
// load in flight and one more. A cold load runs at once over whatever
// is out or waiting, and answers what was asked before it.

// long enough to fold a turn's envelopes, short next to a turn
export const TRAIL_MS = 300;

export type Timer = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Flight {
  // the token of the load out, 0 for none
  private out = 0;
  private tokens = 0;
  private pause: unknown = null;
  private trailing = false;

  constructor(
    private readonly warm: () => Promise<void>,
    private readonly timer: Timer = realTimer,
    private readonly ms = TRAIL_MS,
  ) {}

  // a warm load: now when nothing is out or pausing, else the trailing one
  ask(): void {
    if (this.out !== 0 || this.pause !== null) {
      this.trailing = true;
      return;
    }
    void this.run(this.warm, true);
  }

  // a load at once, over anything out or waiting. The pause follows a
  // warm load, so warm loads never run back to back, and any load with
  // an ask trailing it; the first ask after a navigation loads at once
  run(load: () => Promise<void>, warm = false): Promise<void> {
    this.stop();
    const token = ++this.tokens;
    this.out = token;
    return load().finally(() => {
      if (this.out !== token) return;
      this.out = 0;
      if (!warm && !this.trailing) return;
      this.pause = this.timer.set(() => {
        this.pause = null;
        if (!this.trailing) return;
        this.trailing = false;
        void this.run(this.warm, true);
      }, this.ms);
    });
  }

  // nothing out counts and nothing waits: the list went or was replaced
  stop(): void {
    if (this.pause !== null) this.timer.clear(this.pause);
    this.pause = null;
    this.trailing = false;
    this.out = 0;
  }
}
