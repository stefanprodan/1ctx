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
// email is set up, so the sign-in page offers its links
export const emailOn = signal(false);
// an admin picked a transcription model, so the composer offers its mic
export const dictationOn = signal(false);

// Every word on dictationOn has a ticket: a load or a clip takes one when
// it asks, a write (a save, a flip, a sign-out) when it lands. The newest
// ticket wins, so a load or a clip's 404 asked before a save never undoes
// it.
let ticket = 0;
let landed = 0;

export function dictationTicket(): number {
  return ++ticket;
}

export function landDictationOn(on: boolean, held: number): void {
  if (held <= landed) return;
  landed = held;
  dictationOn.value = on;
}

export function setDictationOn(on: boolean): void {
  landDictationOn(on, dictationTicket());
}

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
  if (user === null) setDictationOn(false);
}

// any 401 means the login behind the cookie is gone
onUnauthorized(() => {
  if (me.value) setMe(null);
});

export async function loadMe(): Promise<void> {
  const mine = ++turn;
  const asked = dictationTicket();
  meError.value = null;
  try {
    const body = await api<MeResponse>("/api/me");
    emailOn.value = body.emailOn;
    if (turn === mine) {
      me.value = body.user;
      landDictationOn(body.dictationOn, asked);
    }
  } catch (err) {
    if (turn === mine) {
      meError.value = failure(err);
    }
  }
}

export async function login(body: LoginRequest): Promise<void> {
  const { user } = await api<LoginResponse>("/api/login", "POST", body);
  setMe(user);
  void loadDictationOn();
}

// a sign-in answers the user alone, so whether Dictation is on is asked
// after it; a failure leaves the mic hidden until the next load
export async function loadDictationOn(): Promise<void> {
  const mine = turn;
  const asked = dictationTicket();
  try {
    const body = await api<MeResponse>("/api/me");
    if (turn === mine) landDictationOn(body.dictationOn, asked);
  } catch {
    // the mic stays hidden: nothing else depends on it
  }
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
