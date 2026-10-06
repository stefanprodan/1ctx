// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  AdminUser,
  UpdateUserRequest,
} from "../../../shared/api/users.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import {
  isEmail,
  MAX_EMAIL,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD,
  type Role,
} from "../../../shared/words.ts";
import { ago } from "../../lib/format.ts";

export const ROLE_CHOICES: { value: Role; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

// how a new user gets a first password: with email on, an invite by
// default, so the admin never holds it
export type FirstPassword = "invite" | "password";
export const FIRST_PASSWORD_CHOICES: { value: FirstPassword; label: string }[] =
  [
    { value: "invite", label: "Send an invite" },
    { value: "password", label: "Set a password" },
  ];

// what the new user form sends for the first password
export function firstPasswordOf(
  emailOn: boolean,
  pick: FirstPassword,
  password: string,
): { invite: true } | { password: string } {
  return emailOn && pick === "invite" ? { invite: true } : { password };
}

// the card that emails a user a link: an invite again while they have
// not chosen a password, else a reset
export function linkCardWords(user: UserAccount): {
  kind: "invite" | "reset-link";
  title: string;
  line: string;
  button: string;
  sent: string;
} {
  const sent = `Sent to ${user.email}.`;
  if (user.disabled) {
    return {
      kind: "reset-link",
      title: "Reset password",
      line: "Enable them first.",
      button: "Send reset link",
      sent,
    };
  }
  return user.mustChangePassword
    ? {
        kind: "invite",
        title: "Invite",
        line: "Emails a new link to choose a password. The last one stops working.",
        button: "Send invite",
        sent,
      }
    : {
        kind: "reset-link",
        title: "Reset password",
        line: `Emails ${user.fullName} a link to choose a new password. It works for 30 minutes.`,
        button: "Send reset link",
        sent,
      };
}

// the server holds the username rule
export function usernameProblem(value: string): string | null {
  return value.trim() === "" ? "Enter a username" : null;
}

export function emailProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter an email";
  if (trimmed.length > MAX_EMAIL)
    return `Keep it under ${MAX_EMAIL} characters`;
  if (!isEmail(trimmed.toLowerCase())) return "Not an email address";
  return null;
}

// a zone is picked, never guessed from the admin's browser
export function tzProblem(value: string): string | null {
  return value === "" ? "Pick a time zone" : null;
}

// typed once, no confirm box: the admin sees it and hands it over
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD)
    return `The password needs at least ${MIN_PASSWORD} characters`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES)
    return `The password needs at most ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

type UserField = "username" | "fullName" | "email" | "tz" | "role" | "password";

// the words are the parsers' and the conflicts' in access/
export function userFieldOf(message: string): UserField | undefined {
  const m = message.toLowerCase();
  if (m.startsWith("username")) return "username";
  if (m.startsWith("full name")) return "fullName";
  if (m.startsWith("email")) return "email";
  if (m.startsWith("time zone")) return "tz";
  if (m.startsWith("role") || m.includes("own role")) return "role";
  if (m.startsWith("password")) return "password";
  return undefined;
}

// with email on a placeholder is never emailed, so it is not shown as
// an address; with email off the page reads as it did before email
export function metaLine(user: UserAccount, emailOn = false): string {
  return `@${user.username} · ${
    emailOn && user.emailPlaceholder ? "No real email" : user.email
  }`;
}

function todayIn(tz: string, now: number): string {
  const day = (timeZone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  try {
    return day(tz);
  } catch {
    return day("UTC");
  }
}

const todayYear = (ms: number) => String(new Date(ms).getUTCFullYear());

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

export function idleDays(
  user: Pick<AdminUser, "lastVisitDay" | "tz">,
  now: number,
): number | null {
  if (user.lastVisitDay === null) return null;
  const today = dayMs(todayIn(user.tz, now));
  return Math.round((today - dayMs(user.lastVisitDay)) / 86_400_000);
}

// a visit is kept per day, so an hour would claim more than is known
export function lastActive(
  user: Pick<AdminUser, "lastVisitDay" | "tz">,
  now: number,
): string {
  if (user.lastVisitDay === null) return "never";
  const today = dayMs(todayIn(user.tz, now));
  const last = dayMs(user.lastVisitDay);
  const days = Math.round((today - last) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 28) return ago(last, today);
  // read in UTC as it was written, so no reader's zone moves it
  const year = user.lastVisitDay.slice(0, 4) !== todayYear(today);
  return new Date(last).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
}

function activeLine(
  user: Pick<AdminUser, "lastVisitDay" | "tz">,
  now: number,
): string {
  return user.lastVisitDay === null
    ? "never active"
    : `active ${lastActive(user, now)}`;
}

export function stateLine(user: AdminUser, now: number): string {
  const state = user.disabled
    ? "disabled"
    : user.mustChangePassword
      ? "password to change"
      : activeLine(user, now);
  return `${user.role} · ${state}`;
}

export function userCounts(users: readonly AdminUser[]): {
  admins: number;
  members: number;
  disabled: number;
} {
  return {
    admins: users.filter((u) => u.role === "admin").length,
    members: users.filter((u) => u.role === "member").length,
    disabled: users.filter((u) => u.disabled).length,
  };
}

// the server's two refusals
export function roleLock(
  user: UserAccount,
  meId: string,
  admins: number,
): string | null {
  if (user.id === meId) return "You cannot change your own role.";
  if (user.role === "admin" && !user.disabled && admins <= 1)
    return "The last admin keeps the role.";
  return null;
}

// the server's two refusals
export function disableLock(
  user: UserAccount,
  meId: string,
  admins: number,
): string | null {
  if (user.id === meId) return "You cannot disable yourself.";
  if (user.role === "admin" && !user.disabled && admins <= 1)
    return "The last admin stays enabled.";
  return null;
}

export function adminCount(users: UserAccount[]): number {
  return users.filter((u) => u.role === "admin" && !u.disabled).length;
}

// only what changed, so a stale field is never sent
export function patchOf(
  user: UserAccount,
  fields: { username: string; fullName: string; email: string; tz: string },
): UpdateUserRequest | null {
  const body: UpdateUserRequest = {};
  const username = fields.username.trim();
  const fullName = fields.fullName.trim();
  const email = fields.email.trim().toLowerCase();
  if (username !== user.username) body.username = username;
  if (fullName !== user.fullName) body.fullName = fullName;
  if (email !== user.email) body.email = email;
  if (fields.tz !== user.tz) body.tz = fields.tz;
  return Object.keys(body).length === 0 ? null : body;
}

// without the lookalikes (0 O o, 1 l I), so it survives voice or paper
const PASSWORD_CHARS =
  "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 20): string {
  const n = PASSWORD_CHARS.length;
  // bytes past the largest multiple of n are drawn again: no modulo bias
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += PASSWORD_CHARS[byte % n];
    }
  }
  return out;
}
