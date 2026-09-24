// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the admin's Overview and Storage pages read. Storage is loaded
// when the page is reached and again on Refresh. The Overview is kept
// current while it is on screen and the tab is seen: the server's load
// every LOAD_SAMPLE_MS, the days and all time every PAST_EVERY_MS, both
// again as soon as the tab is seen again. A load keeps the last answer
// on screen until the next lands; a failure keeps it too.

import { effect, signal } from "@preact/signals";
import {
  LOAD_SAMPLE_MS,
  type LoadResponse,
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
export const overviewError = signal<Failure | null>(null);
export const overviewLoading = signal(false);

// the last load the server answered, and the failure of the polls since
export const serverLoad = signal<LoadResponse | null>(null);
export const serverLoadError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;
let overviewTurn = 0;
let loadTurn = 0;
// a poll waiting for its answer; the next tick skips rather than drop it
let loadAsking = false;

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
  overviewError.value = null;
  overviewLoading.value = false;
  dropLoad();
  serverLoad.value = null;
  serverLoadError.value = null;
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

export async function loadOverview(): Promise<void> {
  const forUser = owner;
  const mine = ++overviewTurn;
  const current = () => owner === forUser && mine === overviewTurn;
  overviewLoading.value = true;
  try {
    const body = await api<OverviewResponse>(
      `/api/admin/overview?tz=${encodeURIComponent(zone())}`,
    );
    if (!current()) return;
    overview.value = body;
    overviewError.value = null;
  } catch (err) {
    if (current()) overviewError.value = failure(err);
  } finally {
    if (current()) overviewLoading.value = false;
  }
}

// the server keeps the overview a minute, so asking sooner gains nothing
export const PAST_EVERY_MS = 60_000;

async function pollLoad(): Promise<void> {
  if (loadAsking) return;
  const forUser = owner;
  const mine = ++loadTurn;
  const current = () => owner === forUser && mine === loadTurn;
  loadAsking = true;
  try {
    const body = await api<LoadResponse>("/api/admin/load");
    if (!current()) return;
    serverLoad.value = body;
    serverLoadError.value = null;
  } catch (err) {
    if (current()) serverLoadError.value = failure(err);
  } finally {
    if (current()) loadAsking = false;
  }
}

// an answer still out lands nowhere, and the next tick asks again
function dropLoad(): void {
  loadTurn++;
  loadAsking = false;
}

// The tab as the watch sees it: whether it is seen, a way to hear that
// change, the time and a repeating timer, so a test can drive them.
export type Tab = {
  hidden(): boolean;
  listen(change: () => void): () => void;
  now(): number;
  every(ms: number, tick: () => void): () => void;
};

const browserTab: Tab = {
  hidden: () => document.visibilityState === "hidden",
  listen(change) {
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  },
  now: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};

// Keeps the Overview current while the caller holds it; the stop it
// answers ends it. The route's load has just asked for the days, so the
// first tick asks only for the load. A hidden tab asks nothing.
export function watchOverview(tab: Tab = browserTab): () => void {
  let stopTimer: (() => void) | null = null;
  let pastAt = tab.now();
  const past = () => {
    if (tab.now() - pastAt < PAST_EVERY_MS || overviewLoading.value) return;
    pastAt = tab.now();
    void loadOverview();
  };
  const tick = () => {
    void pollLoad();
    past();
  };
  const pause = () => {
    stopTimer?.();
    stopTimer = null;
    dropLoad();
  };
  const change = () => {
    pause();
    if (tab.hidden()) return;
    tick();
    stopTimer = tab.every(LOAD_SAMPLE_MS, tick);
  };
  const unlisten = tab.listen(change);
  change();
  return () => {
    unlisten();
    pause();
  };
}
