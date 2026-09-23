// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the admin's Overview and Storage pages read: loaded when a page
// is reached (and the Overview on a range change) and again on
// Refresh, never polled. A load keeps the last answer on screen until
// the next lands, so a refresh fades the board instead of emptying it;
// a failure keeps it too.

import { effect, signal } from "@preact/signals";
import {
  OVERVIEW_RANGES,
  type OverviewRange,
  type OverviewResponse,
  type StorageResponse,
} from "../../shared/api/admin.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const storage = signal<StorageResponse | null>(null);
export const storageError = signal<Failure | null>(null);
export const storageLoading = signal(false);

export const overview = signal<OverviewResponse | null>(null);
// the range the answer on screen covers
export const overviewRange = signal<OverviewRange | null>(null);
export const overviewError = signal<Failure | null>(null);
export const overviewLoading = signal(false);

let owner: string | null = null;
let turn = 0;
let overviewTurn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  storage.value = null;
  storageError.value = null;
  storageLoading.value = false;
  overviewTurn++;
  overview.value = null;
  overviewRange.value = null;
  overviewError.value = null;
  overviewLoading.value = false;
});

// the day boundaries are the browser's zone
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function loadStorage(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const current = () => owner === forUser && mine === turn;
  storageLoading.value = true;
  try {
    const body = await api<StorageResponse>(
      `/api/admin/storage?tz=${encodeURIComponent(zone())}`,
    );
    if (!current()) return;
    storage.value = body;
    storageError.value = null;
  } catch (err) {
    if (current()) storageError.value = failure(err);
  } finally {
    if (current()) storageLoading.value = false;
  }
}

// the range a query asks for, 30 days when it names none or another
export function rangeOf(query: URLSearchParams): OverviewRange {
  const days = Number(query.get("days"));
  return OVERVIEW_RANGES.find((r) => r === days) ?? 30;
}

export async function loadOverview(days: OverviewRange): Promise<void> {
  const forUser = owner;
  const mine = ++overviewTurn;
  const current = () => owner === forUser && mine === overviewTurn;
  overviewLoading.value = true;
  try {
    const body = await api<OverviewResponse>(
      `/api/admin/overview?tz=${encodeURIComponent(zone())}&days=${days}`,
    );
    if (!current()) return;
    overview.value = body;
    overviewRange.value = days;
    overviewError.value = null;
  } catch (err) {
    if (current()) overviewError.value = failure(err);
  } finally {
    if (current()) overviewLoading.value = false;
  }
}
