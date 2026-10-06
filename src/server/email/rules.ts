// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The email area's pure rules: the kinds, when a failed send is tried
// again, what a public address may be, and the header values 1ctx
// refuses to build.

import { DAY_MS, MINUTE_MS } from "../lib/clock.ts";

// every email the instance sends: the link emails, a security notice, an
// agent's email and an automation's alert
export const EMAIL_KINDS = [
  "reset",
  "signin",
  "invite",
  "notice",
  "agent",
  "alert",
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

// why a row was dropped before SMTP: the recipient is gone, disabled
// or has no real address, or a kind's own check refused it (a link
// email's link was revoked since, the chat or run it links to deleted)
export type DropWord =
  | "gone"
  | "disabled"
  | "placeholder"
  | "opted-out"
  | "no-access"
  | "revoked"
  | "deleted";

// the waits after the first, second and third failed try; the fourth
// failure is final
export const BACKOFF_MS = [MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS] as const;
// a claim this old belongs to a process that died mid-send
export const STALE_CLAIM_MS = MINUTE_MS;
export const FAILED_KEEP_MS = 7 * DAY_MS;
// a sent row, for the caps counted per day
export const SENT_KEEP_MS = DAY_MS;

// when the row is tried again after its attempts-th failure, or null
// when it has failed for good
export function retryAt(attempts: number, now: number): number | null {
  const wait = BACKOFF_MS[attempts - 1];
  return wait === undefined ? null : now + wait;
}

// a C0 or C1 control, DEL or a Unicode line break: a header value
// holding one could start a header of its own
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function hasControl(value: string): boolean {
  return CONTROL.test(value);
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

// the origin of an https:// address, or of an http:// one on a
// loopback host; the error's words otherwise. A path, a query, a
// fragment or user info is refused, so no link is built under
// someone else's prefix
export function publicOrigin(
  value: string,
): { ok: true; origin: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "must be a URL" };
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  ) {
    return {
      ok: false,
      error: "must start with https://, or http:// on a loopback host",
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "must not hold a user or a password" };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { ok: false, error: "must be an origin, with no path" };
  }
  return { ok: true, origin: url.origin };
}

// stable for the row, so a send repeated after a crash reads as one
// email
export function messageIdOf(id: string, fromAddress: string): string {
  return `<${id}@${fromAddress.slice(fromAddress.lastIndexOf("@") + 1)}>`;
}

// the row's Message-ID made one try's own, for a text that differs per
// try: a client that kept the first copy must not drop the second
export function messageIdOfTry(messageId: string, tryId: string): string {
  return messageId.replace(/^<([^@]+)@/, `<$1.${tryId}@`);
}

export function linkOf(origin: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("a link's path starts with one slash");
  }
  return `${origin}${path}`;
}
