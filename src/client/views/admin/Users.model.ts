// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the users pages show and what their forms check before they
// call: an empty field, a malformed email and a mistyped password,
// caught without a round trip. The username rule is the server's alone.

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

// the field shapes the username as it is typed and the server holds
// the rule, so the one slip worth catching here is an empty field
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

// a new user's zone is picked, never guessed from the admin's browser
export function tzProblem(value: string): string | null {
  return value === "" ? "Pick a time zone" : null;
}

// a first password, or a reset: typed once, since the admin sees it
// and hands it over
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD)
    return `The password needs at least ${MIN_PASSWORD} characters`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES)
    return `The password needs at most ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

// the fields of the user form, by the name each control carries
type UserField = "username" | "fullName" | "email" | "tz" | "role" | "password";

// which field a server refusal of the user routes names; the words are
// the parsers' and the conflicts' in access/
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

// "@casey · casey@example.com"
export function metaLine(user: UserAccount): string {
  return `@${user.username} · ${user.email}`;
}

// today as the user's own date, "2026-09-28", UTC for a zone the
// browser does not know
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

// the last day a user used the app against today, both the user's own
// dates, so a reader in another zone never moves the day: "today",
// "yesterday", "3d ago", or "never". A visit is kept per day, so an
// hour would claim more than is known.
export function lastActive(
  user: Pick<AdminUser, "lastVisitDay" | "tz">,
  now: number,
): string {
  if (user.lastVisitDay === null) return "never";
  const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
  const today = ms(todayIn(user.tz, now));
  const last = ms(user.lastVisitDay);
  const days = Math.round((today - last) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 28) return ago(last, today);
  // the date itself, read in UTC as it was written, so no reader's zone
  // moves it
  const year = user.lastVisitDay.slice(0, 4) !== todayYear(today);
  return new Date(last).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
  });
}

// the same in a row: "active today", "never active"
export function activeLine(
  user: Pick<AdminUser, "lastVisitDay" | "tz">,
  now: number,
): string {
  return user.lastVisitDay === null
    ? "never active"
    : `active ${lastActive(user, now)}`;
}

// the row's right side: the role, then a state worth a word or when
// they were last active. "member · active today", "member · disabled"
export function stateLine(user: AdminUser, now: number): string {
  const state = user.disabled
    ? "disabled"
    : user.mustChangePassword
      ? "password to change"
      : activeLine(user, now);
  return `${user.role} · ${state}`;
}

// the list's aside: the admins, the members, the disabled of either
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

// why the role cannot change, or null when it can: the admin's own
// row, and the last admin, are the server's two refusals
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

// why the user cannot be disabled, or null when they can: the admin's
// own row, and the last enabled admin, are the server's two refusals
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

// the admins who can sign in: a disabled one holds nothing up
export function adminCount(users: UserAccount[]): number {
  return users.filter((u) => u.role === "admin" && !u.disabled).length;
}

// the PATCH body: only what changed, so a stale field is never sent,
// and null when nothing did
export function patchOf(
  user: UserAccount,
  fields: {
    username: string;
    fullName: string;
    email: string;
    role: Role;
    tz: string;
  },
): UpdateUserRequest | null {
  const body: UpdateUserRequest = {};
  const username = fields.username.trim();
  const fullName = fields.fullName.trim();
  const email = fields.email.trim().toLowerCase();
  if (username !== user.username) body.username = username;
  if (fullName !== user.fullName) body.fullName = fullName;
  if (email !== user.email) body.email = email;
  if (fields.role !== user.role) body.role = fields.role;
  if (fields.tz !== user.tz) body.tz = fields.tz;
  return Object.keys(body).length === 0 ? null : body;
}

// letters and digits without the ones read alike (0 O o, 1 l I), so a
// password handed over by voice or on paper survives
const PASSWORD_CHARS =
  "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// a first password for New user's Generate: 20 of those, each drawn
// evenly from the browser's random source
export function generatePassword(length = 20): string {
  const n = PASSWORD_CHARS.length;
  // the largest multiple of n below 256: bytes past it are drawn again,
  // so no character comes up more often than another
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += PASSWORD_CHARS[byte % n];
    }
  }
  return out;
}
