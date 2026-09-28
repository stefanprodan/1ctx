// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access board's numbers: who signed in over the last 30 days and
// which projects had a turn or a run, in the browser's zone, loaded
// when the board is reached and again every 30 seconds while it is seen,
// with the users and the team projects it groups. A failure keeps the
// last answer.

import { effect, signal } from "@preact/signals";
import type { AccessBoardResponse } from "../../shared/api/access.ts";
import { type Failure, failure } from "../lib/format.ts";
import { browserTab, type PollDriver, pollWhileSeen } from "../lib/poll.ts";
import { browserZone } from "../lib/zone.ts";
import { loadAdminProjects } from "./admin-projects.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";
import { loadUsers } from "./users.ts";

export const BOARD_EVERY_MS = 30_000;

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

// the board and the lists it groups, together
export async function refreshAccessBoard(): Promise<void> {
  await Promise.all([loadAccessBoard(), loadUsers(), loadAdminProjects()]);
}

// keeps the board current while the caller holds it and the tab is seen
export const watchAccessBoard = (tab: PollDriver = browserTab): (() => void) =>
  pollWhileSeen(BOARD_EVERY_MS, () => void refreshAccessBoard(), tab);
