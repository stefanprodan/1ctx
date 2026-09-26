// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the user's visible projects spent: the last seven days, the year
// of days and the recent weeks of days. Kept only for the user it was
// asked for, as every entity is.

import { effect, signal } from "@preact/signals";
import type {
  DaysUsageResponse,
  WeekUsageResponse,
} from "../../shared/api/usage.ts";
import { browserZone } from "../lib/zone.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const week = signal<WeekUsageResponse | null>(null);

// the weeks Home's aside asks for: as many as its 280px column holds at
// the heatmap's cell size
export const RECENT_WEEKS = 16;

const MAX_TIMEOUT = 2_147_483_647;

// a server clock a little behind the browser answers midnight with the
// same until, so the reload waits past it and never less than a minute
const MIDNIGHT_SLACK = 5_000;
const MIN_RELOAD = 60_000;

let owner: string | null = null;
let weekTurn = 0;

// One days answer and its lifecycle: its own turn, so loads of the year
// and of the recent weeks never discard each other, and its own midnight
// timer, since each window gains the new day.
function daysEntity(weeks: number | null) {
  const answer = signal<DaysUsageResponse | null>(null);
  // a first load that failed: the page stops drawing the loading state
  const failed = signal(false);
  let turn = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const arm = (until: number) => {
    clear();
    const delay = Math.min(
      MAX_TIMEOUT,
      Math.max(MIN_RELOAD, until - Date.now() + MIDNIGHT_SLACK),
    );
    timer = setTimeout(() => {
      timer = null;
      void load();
    }, delay);
  };

  async function load(): Promise<void> {
    const forUser = owner;
    const mine = ++turn;
    const current = () => owner === forUser && mine === turn;
    const query = `tz=${encodeURIComponent(browserZone())}${
      weeks === null ? "" : `&weeks=${weeks}`
    }`;
    try {
      const body = await api<DaysUsageResponse>(`/api/usage/days?${query}`);
      if (current()) {
        failed.value = false;
        answer.value = body;
        arm(body.until);
      }
    } catch {
      if (!current()) return;
      // a refresh that fails keeps the chart on screen and tries again; a
      // first load that fails has nothing to keep
      if (answer.value === null) {
        clear();
        failed.value = true;
      } else {
        arm(Date.now());
      }
    }
  }

  const reset = () => {
    turn++;
    clear();
    failed.value = false;
    answer.value = null;
  };

  return { answer, failed, load, reset };
}

const year = daysEntity(null);
const recent = daysEntity(RECENT_WEEKS);

// the year, for the Projects page
export const days = year.answer;
export const daysFailed = year.failed;
export const loadDays = year.load;
// the last weeks, for Home's aside
export const recentDays = recent.answer;
export const recentDaysFailed = recent.failed;
export const loadRecentDays = recent.load;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  weekTurn++;
  week.value = null;
  year.reset();
  recent.reset();
});

export async function loadWeek(): Promise<void> {
  const forUser = owner;
  const mine = ++weekTurn;
  const current = () => owner === forUser && mine === weekTurn;
  try {
    const body = await api<WeekUsageResponse>(
      `/api/usage/week?tz=${encodeURIComponent(browserZone())}`,
    );
    if (current()) week.value = body;
  } catch {
    if (current()) week.value = null;
  }
}
