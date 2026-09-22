// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The last answers of an entity by key, so a page seen before draws at
// once while its load runs again. Bounded: past its size the value used
// least recently goes. It is not a signal; the entity puts a held value
// into its signal when the key on screen changes.

export class Held<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly size = 16) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.size) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  // every entry through fn: the value it returns stays, null drops it
  update(fn: (value: V, key: string) => V | null): void {
    for (const [key, value] of [...this.entries]) {
      const next = fn(value, key);
      if (next === null) this.entries.delete(key);
      else if (next !== value) this.entries.set(key, next);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
