// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user: the one entity every view reads. Undefined until
// the first load answers, null when nobody is signed in. A load that
// fails leaves me undefined and sets the error so the root can offer a
// retry instead of a blank page.

import { signal } from "@preact/signals";
import type { LoginRequest, MeResponse } from "../../shared/api/access.ts";
import type { Me } from "../../shared/contracts/user.ts";
import { isRole } from "../../shared/words.ts";
import { type Failure, failure } from "../lib/format.ts";
import { ApiError, api, onUnauthorized } from "./api.ts";
import { signInPost } from "./sign-in.ts";

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

export function isMe(u: unknown): u is Me {
  if (typeof u !== "object" || u === null) return false;
  const m = u as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.username === "string" &&
    typeof m.fullName === "string" &&
    isRole(m.role)
  );
}

// a GET /api/me answer as read: user null names nobody; null when it is
// no answer at all (a proxy's page, a body cut short)
export function readMeAnswer(body: unknown): MeResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.user !== null && !isMe(b.user)) return null;
  return {
    user: b.user,
    emailOn: b.emailOn === true,
    dictationOn: b.dictationOn === true,
  };
}

export type Who = "in" | "nobody" | "failed";

// a later load supersedes one in flight, which then answers as it does
let loads = 0;
let current: Promise<Who> = Promise.resolve("nobody");

export function loadMe(): Promise<Who> {
  current = readMe(++loads, ++turn);
  return current;
}

async function readMe(load: number, mine: number): Promise<Who> {
  const asked = dictationTicket();
  meError.value = null;
  try {
    const read = readMeAnswer(await api<unknown>("/api/me"));
    if (read === null) throw new ApiError(0, "the server failed");
    if (load !== loads) return current;
    emailOn.value = read.emailOn;
    if (turn !== mine) return me.value ? "in" : "nobody";
    me.value = read.user;
    landDictationOn(read.dictationOn, asked);
    return read.user === null ? "nobody" : "in";
  } catch (err) {
    if (load !== loads) return current;
    if (turn === mine) meError.value = failure(err);
    return "failed";
  }
}

// a sign-in's post opened a login: who it is is read, and the page
// leaves the sign-in only once it is; a read that fails or names nobody
// throws, with the failure's words or "not signed in"
export async function opened(): Promise<void> {
  if ((await loadMe()) !== "in") {
    throw new ApiError(0, meError.peek()?.words ?? "not signed in");
  }
}

export async function login(body: LoginRequest): Promise<void> {
  await signInPost("/api/login", body, "wrong admin key");
  await opened();
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
