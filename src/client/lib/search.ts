// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";

export function matches(query: string, fields: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return fields.some((field) => field.toLowerCase().includes(needle));
}

// the entity keeps its own order; a page shows it by name
export const byName = <T extends { name: string }>(rows: readonly T[]): T[] =>
  rows.slice().sort((a, b) => a.name.localeCompare(b.name));

// an empty list says no count
export const countOf = (shown: number, all: number): string | undefined =>
  all === 0 ? undefined : shown === all ? String(all) : `${shown} of ${all}`;

type Fields<T> = (row: T) => (string | null | undefined)[];

export function searchList<T>(
  all: readonly T[],
  q: string,
  fields: Fields<T>,
): { shown: T[]; count: string | undefined } {
  const shown = all.filter((row) =>
    matches(
      q,
      fields(row).filter((f): f is string => typeof f === "string"),
    ),
  );
  return { shown, count: countOf(shown.length, all.length) };
}

export function useListSearch<T>(
  all: readonly T[],
  fields: Fields<T>,
): { q: Signal<string>; shown: T[]; count: string | undefined } {
  const q = useSignal("");
  return { q, ...searchList(all, q.value, fields) };
}
