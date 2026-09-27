// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one rule a list filtered in place follows: a row stays when any of
// its fields holds the query, in any case; an empty query keeps them all.

export function matches(query: string, fields: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return fields.some((field) => field.toLowerCase().includes(needle));
}

// a list as a page shows it, by name; the entity keeps its own order
export const byName = <T extends { name: string }>(rows: readonly T[]): T[] =>
  rows.slice().sort((a, b) => a.name.localeCompare(b.name));
