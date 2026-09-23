// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the admin's Storage page reads: loaded when the page is reached
// and again on Refresh, never polled. A load keeps the last answer on
// screen until the next lands, so a refresh fades the board instead of
// emptying it; a failure keeps it too.

import { effect, signal } from "@preact/signals";
import type { StorageResponse } from "../../shared/api/admin.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const storage = signal<StorageResponse | null>(null);
export const storageError = signal<Failure | null>(null);
export const storageLoading = signal(false);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  storage.value = null;
  storageError.value = null;
  storageLoading.value = false;
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
