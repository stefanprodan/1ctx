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
import { ApiError, api, onUnauthorized, quietGet } from "./api.ts";
import { signInPost, signInWords } from "./sign-in.ts";

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
// no answer at all (a proxy's page, a body cut short, a flag that is no
// boolean), so the flags held stay as they were
export function readMeAnswer(body: unknown): MeResponse | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.user !== null && !isMe(b.user)) return null;
  if (typeof b.emailOn !== "boolean" || typeof b.dictationOn !== "boolean") {
    return null;
  }
  return { user: b.user, emailOn: b.emailOn, dictationOn: b.dictationOn };
}

export type Who = "in" | "nobody" | "failed";
// who, and the words of a failure for the caller that shows them
type Read = { who: Who; words: string | null };

// a later load supersedes one in flight, which then answers as it does
let loads = 0;
let current: Promise<Read> = Promise.resolve({ who: "nobody", words: null });

// the page's load: a failure is meError, which the root draws
export async function loadMe(): Promise<Who> {
  current = readMe(++loads, ++turn, true);
  return (await current).who;
}

// a sign-in's read of who it opened: its failure is the card's to say,
// never meError, so the card stays drawn with its own line
export function confirmMe(): Promise<Read> {
  current = readMe(++loads, ++turn, false);
  return current;
}

async function readMe(
  load: number,
  mine: number,
  page: boolean,
): Promise<Read> {
  const asked = dictationTicket();
  if (page) meError.value = null;
  try {
    // without api()'s 401 hook: a superseded read's 401 must not sign
    // out a newer sign-in, so its effect waits for the checks below
    const read = readMeAnswer(await quietGet<unknown>("/api/me"));
    if (read === null) throw new ApiError(0, "the server failed");
    if (load !== loads) return current;
    emailOn.value = read.emailOn;
    if (turn !== mine) return { who: me.value ? "in" : "nobody", words: null };
    me.value = read.user;
    landDictationOn(read.dictationOn, asked);
    return { who: read.user === null ? "nobody" : "in", words: null };
  } catch (err) {
    if (load !== loads) return current;
    if (turn !== mine) return { who: "failed", words: null };
    if (err instanceof ApiError && err.status === 401) {
      if (me.value) setMe(null);
      return { who: "nobody", words: null };
    }
    if (!page) {
      // the card says the sign-in's own words for the status
      const status = err instanceof ApiError ? err.status : 0;
      return { who: "failed", words: signInWords(status, "signed out") };
    }
    const failed = failure(err);
    meError.value = failed;
    return { who: "failed", words: failed.words };
  }
}

// a sign-in's post opened a login: who it is is read, and the page
// leaves the sign-in only once it is; a read that fails or names nobody
// throws, with the failure's words or "not signed in"
export async function opened(): Promise<void> {
  const { who, words } = await confirmMe();
  if (who !== "in") throw new ApiError(0, words ?? "not signed in");
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
