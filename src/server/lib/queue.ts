// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A bounded admission queue in arrival order. Cancellation removes a
// waiter before it holds a slot its caller no longer needs, and a
// release runs once however often it is called.

export class Queue {
  active = 0;
  private waiting = new Set<() => void>();

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.waiting.delete(start);
        reject(signal.reason);
      };
      const start = () => {
        this.waiting.delete(start);
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.values().next().value?.();
        });
      };
      if (signal.aborted) {
        reject(signal.reason);
      } else if (this.active < this.limit) {
        start();
      } else {
        signal.addEventListener("abort", cancel, { once: true });
        this.waiting.add(start);
      }
    });
  }
}
