// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Signal } from "@preact/signals";
import { useRef } from "preact/hooks";

type Box<T> = { current: T };

export type HeldDrafts<R, D> = { id: string; drafts: D; last: R | null };

export function stepDrafts<R extends { id: string }, D>(
  held: Box<HeldDrafts<R, D> | null>,
  row: R | null,
  of: (row: R) => D,
  follow: (drafts: D, before: R, after: R) => void,
): D | null {
  if (row === null) {
    if (held.current !== null) held.current.last = null;
    return null;
  }
  const h = held.current;
  if (h?.id !== row.id) {
    held.current = { id: row.id, drafts: of(row), last: row };
    return held.current.drafts;
  }
  if (h.last !== null && h.last !== row) follow(h.drafts, h.last, row);
  h.last = row;
  return h.drafts;
}

// one set of drafts per row id; a row that changed under the page goes
// to follow(), so the cards not being edited take it
export function useRowDrafts<R extends { id: string }, D>(
  row: R | null,
  of: (row: R) => D,
  follow: (drafts: D, before: R, after: R) => void,
): D | null {
  return stepDrafts(useRef<HeldDrafts<R, D> | null>(null), row, of, follow);
}

export function stepShown<R extends { id: string }>(
  shown: Box<{ id: string; key: string } | null>,
  list: readonly R[] | null,
  key: string,
  keyOf: (row: R) => string,
): { row: R | null; leaving: boolean } {
  const held = shown.current?.key === key ? shown.current : null;
  const row =
    list?.find((r) => keyOf(r) === key) ??
    list?.find((r) => r.id === held?.id) ??
    null;
  if (row !== null && keyOf(row) === key) shown.current = { id: row.id, key };
  return { row, leaving: row === null && held !== null };
}

// a rename or a delete changes the list a moment before the address
// follows: the row shown last, found by id, holds the page meanwhile
export function useShownRow<R extends { id: string }>(
  list: readonly R[] | null,
  key: string,
  keyOf: (row: R) => string,
): { row: R | null; leaving: boolean } {
  return stepShown(
    useRef<{ id: string; key: string } | null>(null),
    list,
    key,
    keyOf,
  );
}

export async function holding<T>(
  flag: Signal<boolean>,
  call: () => Promise<T>,
): Promise<T> {
  flag.value = true;
  try {
    return await call();
  } finally {
    flag.value = false;
  }
}

export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
