// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, type Signal, signal } from "@preact/signals";
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
// a list's aside reads 30d whatever the Monitor shows
export const overviewRange = signal<OverviewRange>("30d");

export const usage = signal<UsageResponse | null>(null);
export const usageError = signal<Failure | null>(null);
export const usageLoading = signal(false);
export const usageMonth = signal<string | null>(null);
// the address named no month: the page follows the current one
let usageFollows = false;

export const attention = signal<AttentionResponse | null>(null);
export const attentionError = signal<Failure | null>(null);

export const serverLoad = signal<LoadResponse | null>(null);
export const serverLoadError = signal<Failure | null>(null);

// just over the server's keep of these reads, so each ask gets a new one
export const MONITOR_EVERY_MS = 30_000;

let owner: string | null = null;
// a poll waiting for its answer; the next tick skips rather than drop it
let loadAsking = false;

// One answer of a board. A failure keeps the last answer; only the
// latest read for the signed-in user lands, and read says whether it did.
function board<T>(
  value: Signal<T | null>,
  error: Signal<Failure | null>,
  loading?: Signal<boolean>,
) {
  let turn = 0;
  return {
    drop() {
      turn++;
    },
    reset() {
      turn++;
      value.value = null;
      error.value = null;
      if (loading) loading.value = false;
    },
    async read(url: string, quiet = false): Promise<boolean> {
      const forUser = owner;
      const mine = ++turn;
      const current = () => owner === forUser && mine === turn;
      if (loading && !quiet) loading.value = true;
      try {
        const body = await api<T>(url);
        if (current()) {
          value.value = body;
          error.value = null;
        }
      } catch (err) {
        if (current()) error.value = failure(err);
      } finally {
        if (current() && loading) loading.value = false;
      }
      return current();
    },
  };
}

const storageBoard = board(storage, storageError, storageLoading);
const overviewBoard = board(overview, overviewError, overviewLoading);
const usageBoard = board(usage, usageError, usageLoading);
const attentionBoard = board(attention, attentionError);
const loadBoard = board(serverLoad, serverLoadError);

const tz = () => `tz=${encodeURIComponent(browserZone())}`;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  storageBoard.reset();
  overviewBoard.reset();
  usageBoard.reset();
  usageMonth.value = null;
  attentionBoard.reset();
  loadBoard.reset();
  loadAsking = false;
});

export async function loadStorage(): Promise<void> {
  await storageBoard.read(`/api/admin/storage?${tz()}`);
}

export async function loadOverview(
  range: OverviewRange = "30d",
): Promise<void> {
  await overviewBoard.read(`/api/admin/overview?${tz()}&range=${range}`);
}

export function pickOverviewRange(range: OverviewRange): void {
  overviewRange.value = range;
  void loadOverview(range);
}

export function thisMonth(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: browserZone(),
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}`;
}

// quiet: a poll's read, which leaves the board undimmed
export async function loadUsage(
  asked: string | null,
  quiet = false,
): Promise<void> {
  const month =
    asked !== null && MONTH_PATTERN.test(asked) ? asked : thisMonth();
  usageMonth.value = month;
  if (!quiet) usageFollows = asked === null;
  await usageBoard.read(`/api/admin/usage?${tz()}&month=${month}`, quiet);
}

// a past month is closed and never asked again
export const watchUsage = (tab: PollDriver = browserTab): (() => void) =>
  pollWhileSeen(
    MONITOR_EVERY_MS,
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
  await attentionBoard.read("/api/admin/attention");
}

async function pollLoad(): Promise<void> {
  if (loadAsking) return;
  loadAsking = true;
  if (await loadBoard.read("/api/admin/load")) loadAsking = false;
}

// the polls go on as before
export async function refreshOverview(): Promise<void> {
  await Promise.all([
    pollLoad(),
    loadOverview(overviewRange.value),
    loadAttention(),
  ]);
}

// an answer still out lands nowhere, and the next tick asks again
function dropLoad(): void {
  loadBoard.drop();
  loadAsking = false;
}

// The route's load has just asked for the days, so the first tick asks
// only for the load.
export function watchOverview(tab: PollDriver = browserTab): () => void {
  let stopTimer: (() => void) | null = null;
  let pastAt = tab.now();
  const past = () => {
    if (tab.now() - pastAt < MONITOR_EVERY_MS || overviewLoading.value) return;
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
