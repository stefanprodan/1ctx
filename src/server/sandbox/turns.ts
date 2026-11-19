// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One sandbox's turns: the commands in it run at once, but its network
// setup, each push and each save take turns, first come first served.

export class Turns {
  private tail: Promise<void> = Promise.resolve();

  // resolves with the release once every earlier turn was released; a
  // stop while waiting throws and takes no turn
  async take(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => mine);
    let stopped = () => {};
    const stop = new Promise<never>((_, reject) => {
      stopped = () => reject(signal.reason);
      signal.addEventListener("abort", stopped, { once: true });
    });
    try {
      await Promise.race([before, stop]);
    } catch (error) {
      // the turn passes on as soon as the one before it ends
      void before.then(release);
      throw error;
    } finally {
      signal.removeEventListener("abort", stopped);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  }
}
