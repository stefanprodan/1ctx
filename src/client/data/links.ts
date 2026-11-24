// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Signing in by email from the sign-in page: asking for a code, and
// the code. The ask sets the browser's challenge, a cookie the code is
// only tried beside; same-origin fetches carry it. The link an email
// carries opens a page the server draws.

import { effect } from "@preact/signals";
import type { CodeRequest, LinkAskRequest } from "../../shared/api/access.ts";
import { isEmail } from "../../shared/words.ts";
import { me, opened } from "./me.ts";
import { signInPost } from "./sign-in.ts";

// answered the same whoever it names, so there is nothing to read back
export async function askLink(email: string): Promise<void> {
  const body: LinkAskRequest = { email: email.trim() };
  await signInPost("/api/login/link", body, "signed out");
}

// signs this browser in, in place of any other. go takes the landing
// once the server took the code, before who it is is read, so a failure
// after it is a used code
export async function sendCode(
  email: string,
  code: string,
  go: (landing: string) => void,
): Promise<void> {
  const body: CodeRequest = { email: email.trim(), code };
  const answer = (await signInPost(
    "/api/login/code",
    body,
    "wrong or expired code",
  )) as { landing?: unknown } | null;
  if (typeof answer?.landing === "string" && answer.landing.startsWith("/")) {
    go(answer.landing);
  }
  await opened();
}

// the dead link page's ask hands its address over in the fragment,
// which never leaves the browser, so no log holds it: the sign-in
// opens on its code
export const HAND_OVER = "#code=";

export function handedOver(hash: string): string | null {
  if (!hash.startsWith(HAND_OVER)) return null;
  try {
    const email = decodeURIComponent(hash.slice(HAND_OVER.length)).trim();
    return isEmail(email) ? email : null;
  } catch {
    return null;
  }
}

// read once as the page loads, and the reserved fragment always taken
// out of the address bar, so it never stays in the history; the first
// sign-in drawn takes it, and a browser signed in already drops it
let handed: string | null = null;

export function holdHandOver(hash: string, strip: () => void): void {
  if (!hash.startsWith(HAND_OVER)) return;
  handed = handedOver(hash);
  strip();
}

if (typeof location !== "undefined") {
  holdHandOver(location.hash, () => {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {}
  });
}
effect(() => {
  if (me.value) handed = null;
});

export function takeHandOver(): string | null {
  const email = handed;
  handed = null;
  return email;
}
