// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user: the one entity every view reads. Undefined until
// the first load answers, null when nobody is signed in. A load that
// fails leaves me undefined and sets the error so the root can offer a
// retry instead of a blank page.

import { signal } from "@preact/signals";
import type {
  LoginRequest,
  LoginResponse,
  MeResponse,
} from "../../shared/api/access.ts";
import type { Me } from "../../shared/contracts/user.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api, onUnauthorized } from "./api.ts";

export const me = signal<Me | null | undefined>(undefined);
export const meError = signal<Failure | null>(null);

// every change of who is signed in bumps this, so a load that started
// before the change is dropped when it answers: the first load of the
// page can still be in flight when a sign-in on /login lands, and its
// "nobody" must not undo that sign-in
let turn = 0;

// the one way to change who is signed in; profile.ts calls it too,
// since a saved profile replaces the row
export function setMe(user: Me | null): void {
  turn++;
  me.value = user;
}

// any 401 means the login behind the cookie is gone
onUnauthorized(() => {
  if (me.value) setMe(null);
});

export async function loadMe(): Promise<void> {
  const mine = ++turn;
  meError.value = null;
  try {
    const { user } = await api<MeResponse>("/api/me");
    if (turn === mine) me.value = user;
  } catch (err) {
    if (turn === mine) {
      meError.value = failure(err);
    }
  }
}

export async function login(body: LoginRequest): Promise<void> {
  const { user } = await api<LoginResponse>("/api/login", "POST", body);
  setMe(user);
}

// a 401 here means the login was already gone: signed out either way
export async function logout(): Promise<void> {
  try {
    await api("/api/logout", "POST");
  } catch (err) {
    if (!(err instanceof Error && "status" in err && err.status === 401)) {
      throw err;
    }
  }
  setMe(null);
}
