// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access board's numbers: who signed in over the last 30 days and
// which projects had a turn or a run, in the browser's zone, loaded
// when the board is reached. A failure keeps the last answer.

import { effect, signal } from "@preact/signals";
import type { AccessBoardResponse } from "../../shared/api/access.ts";
import { type Failure, failure } from "../lib/format.ts";
import { browserZone } from "../lib/zone.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const accessBoard = signal<AccessBoardResponse | null>(null);
export const accessBoardError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  turn++;
  accessBoard.value = null;
  accessBoardError.value = null;
});

export async function loadAccessBoard(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  accessBoardError.value = null;
  const current = () => owner === forUser && mine === turn;
  try {
    const body = await api<AccessBoardResponse>(
      `/api/admin/access?tz=${encodeURIComponent(browserZone())}`,
    );
    if (!current()) return;
    accessBoard.value = body;
    accessBoardError.value = null;
  } catch (err) {
    if (current()) accessBoardError.value = failure(err);
  }
}
