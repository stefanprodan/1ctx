// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Signing in by email from the sign-in page: asking for a code, and
// the code. The ask sets the browser's challenge, a cookie the code is
// only tried beside; same-origin fetches carry it. The link an email
// carries opens a page the server draws.

import type {
  CodeRequest,
  CodeResponse,
  LinkAskRequest,
  MeResponse,
} from "../../shared/api/access.ts";
import { api } from "./api.ts";
import { loadDictationOn, setDictationOn, setMe } from "./me.ts";

// answered the same whoever it names, so there is nothing to read back
export async function askLink(email: string): Promise<void> {
  const body: LinkAskRequest = { email: email.trim() };
  await api("/api/login/link", "POST", body);
}

// signs this browser in, in place of any other. landed runs once the
// server took the code, before who it is is read from the answer, so a
// failure after it is a used code; go takes the landing first, then the
// user lands
export async function sendCode(
  body: CodeRequest,
  landed: () => void,
  go: (landing: string) => void,
): Promise<void> {
  const answer = await api<Partial<CodeResponse>>("/api/login/code", "POST", {
    email: body.email.trim(),
    code: body.code,
  });
  landed();
  if (answer.user == null || typeof answer.landing !== "string") {
    throw new Error("couldn't load");
  }
  if (answer.landing.startsWith("/")) go(answer.landing);
  setMe(answer.user);
  void loadDictationOn();
}

// who the cookie signs in, read again after a used code's answer failed
export async function whoIs(): Promise<"in" | "nobody" | "failed"> {
  try {
    const body = await api<MeResponse>("/api/me");
    if (body.user === null) return "nobody";
    setMe(body.user);
    setDictationOn(body.dictationOn);
    return "in";
  } catch {
    return "failed";
  }
}

// the dead link page's ask hands its address over in the fragment,
// which never leaves the browser, so no log holds it: the sign-in
// opens on its code
export const HAND_OVER = "#code=";

export function handedOver(hash: string): string | null {
  if (!hash.startsWith(HAND_OVER)) return null;
  try {
    const email = decodeURIComponent(hash.slice(HAND_OVER.length)).trim();
    return email.includes("@") ? email : null;
  } catch {
    return null;
  }
}

// read once as the page loads and taken out of the address bar, so it
// never stays in the history; the first sign-in drawn takes it
let handed: string | null =
  typeof location === "undefined" ? null : handedOver(location.hash);
if (handed !== null) {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {}
}

export function takeHandOver(): string | null {
  const email = handed;
  handed = null;
  return email;
}
