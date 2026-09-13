// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the user's projects spent over the past seven days, for the
// card on Home. Kept only for the user it was asked for, as every
// entity is.

import { effect, signal } from "@preact/signals";
import type { WeekUsageResponse } from "../../shared/api/usage.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const week = signal<WeekUsageResponse | null>(null);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  week.value = null;
});

export async function loadWeek(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const current = () => owner === forUser && mine === turn;
  try {
    const body = await api<WeekUsageResponse>("/api/usage/week");
    if (current()) week.value = body;
  } catch {
    if (current()) week.value = null;
  }
}
