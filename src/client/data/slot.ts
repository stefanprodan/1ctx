// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, type ReadonlySignal, signal } from "@preact/signals";
import { api } from "./api.ts";
import { me } from "./me.ts";

export type Slot<T> = {
  // null for a read that failed
  answers: ReadonlySignal<Readonly<Record<string, T | null>>>;
  load: (id: string) => Promise<void>;
  // undefined until the first read of that id answers
  valueFor: (id: string) => T | null | undefined;
};

// an answer per id, so a page seen before draws its numbers at once
// while the read runs again; only the latest read of an id lands, and
// only for the user who asked
export function readSlot<T>(read: (id: string) => Promise<T>): Slot<T> {
  const answers = signal<Readonly<Record<string, T | null>>>({});
  const turns = new Map<string, number>();
  let owner: string | null = null;
  let turn = 0;
  effect(() => {
    const id = me.value?.id ?? null;
    if (id === owner) return;
    owner = id;
    turns.clear();
    answers.value = {};
  });
  const load = async (id: string): Promise<void> => {
    const forUser = owner;
    const mine = ++turn;
    turns.set(id, mine);
    let value: T | null = null;
    try {
      value = await read(id);
    } catch {}
    if (owner !== forUser || turns.get(id) !== mine) return;
    answers.value = { ...answers.value, [id]: value };
  };
  const valueFor = (id: string): T | null | undefined => {
    const all = answers.value;
    return Object.hasOwn(all, id) ? (all[id] ?? null) : undefined;
  };
  return { answers, load, valueFor };
}

export function usageSlot<T>(url: (id: string) => string): Slot<T> {
  return readSlot((id) => api<T>(url(id)));
}

export function instanceSlot<T>(url: string): {
  load: () => Promise<void>;
  value: () => T | null | undefined;
} {
  const slot = usageSlot<T>(() => url);
  return { load: () => slot.load(""), value: () => slot.valueFor("") };
}
