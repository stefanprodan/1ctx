// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the admin's Monitor pages read. Storage is loaded when the page
// is reached and again on Refresh, Usage when a month is reached and,
// for the current month, every USAGE_EVERY_MS while seen, quietly. The
// Overview is kept current while it is on screen and the tab is seen:
// the server's load every LOAD_SAMPLE_MS, the days, all time and what
// needs attention every PAST_EVERY_MS, all again as soon as the tab is
// seen again. The server keeps those reads a little under the period.
// A load keeps the last answer on screen until the next lands; a
// failure keeps it too.

import { effect, signal } from "@preact/signals";
import {
  type AttentionResponse,
  LOAD_SAMPLE_MS,
  type LoadResponse,
  MONTH_PATTERN,
  type OverviewRange,
  type OverviewResponse,
  type StorageResponse,
  type UsageResponse,
} from "../../shared/api/admin.ts";
import { type Failure, failure } from "../lib/format.ts";
import { browserTab, type PollDriver, pollWhileSeen } from "../lib/poll.ts";
import { browserZone } from "../lib/zone.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const storage = signal<StorageResponse | null>(null);
export const storageError = signal<Failure | null>(null);
export const storageLoading = signal(false);

export const overview = signal<OverviewResponse | null>(null);
export const overviewError = signal<Failure | null>(null);
export const overviewLoading = signal(false);
// the Monitor's Stats range; a list's aside reads 30d whatever it is
export const overviewRange = signal<OverviewRange>("30d");

export const usage = signal<UsageResponse | null>(null);
export const usageError = signal<Failure | null>(null);
export const usageLoading = signal(false);
// the month on screen, or asked for
export const usageMonth = signal<string | null>(null);
// the address named no month: the page follows the current one
let usageFollows = false;

export const attention = signal<AttentionResponse | null>(null);
export const attentionError = signal<Failure | null>(null);

// the last load the server answered, and the failure of the polls since
export const serverLoad = signal<LoadResponse | null>(null);
export const serverLoadError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;
let overviewTurn = 0;
let usageTurn = 0;
let attentionTurn = 0;
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
  usageTurn++;
  usage.value = null;
  usageError.value = null;
  usageLoading.value = false;
  usageMonth.value = null;
  attentionTurn++;
  attention.value = null;
  attentionError.value = null;
  dropLoad();
  serverLoad.value = null;
  serverLoadError.value = null;
});

export async function loadStorage(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const current = () => owner === forUser && mine === turn;
  storageLoading.value = true;
  try {
    const body = await api<StorageResponse>(
      `/api/admin/storage?tz=${encodeURIComponent(browserZone())}`,
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

export async function loadOverview(
  range: OverviewRange = "30d",
): Promise<void> {
  const forUser = owner;
  const mine = ++overviewTurn;
  const current = () => owner === forUser && mine === overviewTurn;
  overviewLoading.value = true;
  try {
    const body = await api<OverviewResponse>(
      `/api/admin/overview?tz=${encodeURIComponent(browserZone())}&range=${range}`,
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

// the Stats switch: the range, read at once
export function pickOverviewRange(range: OverviewRange): void {
  overviewRange.value = range;
  void loadOverview(range);
}

// this month in the browser's zone, "2026-09"
export function thisMonth(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: browserZone(),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}`;
}

// a month from the address, this month when it names none or no month
// quiet: a poll's read, which leaves the board undimmed
export async function loadUsage(
  asked: string | null,
  quiet = false,
): Promise<void> {
  const month =
    asked !== null && MONTH_PATTERN.test(asked) ? asked : thisMonth();
  const forUser = owner;
  const mine = ++usageTurn;
  const current = () => owner === forUser && mine === usageTurn;
  usageMonth.value = month;
  if (!quiet) {
    usageFollows = asked === null;
    usageLoading.value = true;
  }
  try {
    const body = await api<UsageResponse>(
      `/api/admin/usage?tz=${encodeURIComponent(browserZone())}&month=${month}`,
    );
    if (!current()) return;
    usage.value = body;
    usageError.value = null;
  } catch (err) {
    if (current()) usageError.value = failure(err);
  } finally {
    if (current()) usageLoading.value = false;
  }
}

// Keeps the current month current while the caller holds it and the tab
// is seen, stepping to the next month at its midnight when the address
// named none; a past month is closed and never asked again.
export const watchUsage = (tab: PollDriver = browserTab): (() => void) =>
  pollWhileSeen(
    USAGE_EVERY_MS,
    () => {
      if (usageLoading.value) return;
      if (usageFollows) void loadUsage(null, true);
      else if (usageMonth.value === thisMonth()) {
        void loadUsage(usageMonth.value, true);
      }
    },
    tab,
  );

export async function loadAttention(): Promise<void> {
  const forUser = owner;
  const mine = ++attentionTurn;
  const current = () => owner === forUser && mine === attentionTurn;
  try {
    const body = await api<AttentionResponse>("/api/admin/attention");
    if (!current()) return;
    attention.value = body;
    attentionError.value = null;
  } catch (err) {
    if (current()) attentionError.value = failure(err);
  }
}

// just over the server's keep of these reads, so each ask gets a new one
export const PAST_EVERY_MS = 30_000;
export const USAGE_EVERY_MS = 30_000;

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

// the live page's Refresh: the load, the days and what needs attention
// at once, the polls going on as before
export async function refreshOverview(): Promise<void> {
  await Promise.all([
    pollLoad(),
    loadOverview(overviewRange.value),
    loadAttention(),
  ]);
}

// an answer still out lands nowhere, and the next tick asks again
function dropLoad(): void {
  loadTurn++;
  loadAsking = false;
}

// Keeps the Overview current while the caller holds it; the stop it
// answers ends it. The route's load has just asked for the days, so the
// first tick asks only for the load. A hidden tab asks nothing.
export function watchOverview(tab: PollDriver = browserTab): () => void {
  let stopTimer: (() => void) | null = null;
  let pastAt = tab.now();
  const past = () => {
    if (tab.now() - pastAt < PAST_EVERY_MS || overviewLoading.value) return;
    pastAt = tab.now();
    void loadOverview(overviewRange.value);
    void loadAttention();
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
