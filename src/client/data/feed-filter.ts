// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The feed's filter: what a list is read under, its key among the held
// first pages, and its address on the route.

import type { SessionOrigin } from "../../shared/words.ts";

// origin narrows the rows to chats or to runs; null lists both.
// attention is the Flagged pick: the automations with an open
// alert, one line each, newest alert first (alert-rows.ts)
export type ListFilter = {
  project: string | null;
  q: string;
  origin?: SessionOrigin | null;
  attention?: boolean;
};

export const keyOf = (f: ListFilter) =>
  JSON.stringify([f.project, f.q, f.origin ?? null, f.attention ?? false]);

export const sameFilter = (a: ListFilter, b: ListFilter) =>
  a.project === b.project &&
  a.q === b.q &&
  (a.origin ?? null) === (b.origin ?? null) &&
  (a.attention ?? false) === (b.attention ?? false);

export function address(
  filter: Required<ListFilter>,
  before: string | null,
): string {
  const params = new URLSearchParams();
  if (filter.project !== null) params.set("project", filter.project);
  if (filter.q !== "") params.set("q", filter.q);
  if (filter.attention) params.set("attention", "1");
  else if (filter.origin) params.set("origin", filter.origin);
  if (before !== null) params.set("before", before);
  const search = params.toString();
  return `/api/sessions${search === "" ? "" : `?${search}`}`;
}
