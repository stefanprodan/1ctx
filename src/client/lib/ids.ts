// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Lists of ids a form picks by box: the same set in any order, and one
// id flipped in or out.

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((id, i) => id === y[i]);
}

export const toggledId = (ids: readonly string[], id: string): string[] =>
  ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
