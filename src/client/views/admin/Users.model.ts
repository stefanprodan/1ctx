// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the users page shows and what its forms check before they call:
// the same rules the server applies, so a slip is caught without a
// round trip, and the server's word is still the last.

import type { UserAccount } from "../../../shared/contracts/user.ts";
import {
  isEmail,
  isUsername,
  MAX_EMAIL,
  MAX_PASSWORD_BYTES,
  MAX_USERNAME,
  MIN_PASSWORD,
  MIN_USERNAME,
  type Role,
} from "../../../shared/words.ts";
import { longDate } from "../../lib/format.ts";

export { fullNameProblem } from "../profile/Profile.model.ts";

export const ROLE_CHOICES: { value: Role; label: string; text: string }[] = [
  { value: "member", label: "Member", text: "Chats in their projects." },
  { value: "admin", label: "Admin", text: "Runs the server." },
];

export function usernameProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter a username";
  if (trimmed.length < MIN_USERNAME || trimmed.length > MAX_USERNAME)
    return `${MIN_USERNAME} to ${MAX_USERNAME} characters`;
  if (!isUsername(trimmed))
    return "Lowercase letters, digits, dots, dashes and underscores";
  return null;
}

export function emailProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "Enter an email";
  if (trimmed.length > MAX_EMAIL)
    return `Keep it under ${MAX_EMAIL} characters`;
  if (!isEmail(trimmed.toLowerCase())) return "Not an email address";
  return null;
}

// a first password, or a reset: typed twice, since nobody sees it
export function newPasswordProblem(next: string, again: string): string | null {
  if (next.length < MIN_PASSWORD)
    return `The password needs at least ${MIN_PASSWORD} characters`;
  if (new TextEncoder().encode(next).length > MAX_PASSWORD_BYTES)
    return `The password needs at most ${MAX_PASSWORD_BYTES} bytes`;
  if (again !== next) return "The two passwords differ";
  return null;
}

// "@oana · oana@example.com"
export function metaLine(user: UserAccount): string {
  return `@${user.username} · ${user.email}`;
}

// "since 12 September 2026"
export function sinceLine(user: UserAccount): string {
  return `since ${longDate(user.createdAt)}`;
}

// the row's right side: the role, then the states worth a word, then
// since when. "member · disabled · since 12 September 2026"
export function stateLine(user: UserAccount): string {
  const parts: string[] = [user.role];
  if (user.disabled) parts.push("disabled");
  else if (user.mustChangePassword) parts.push("password to change");
  parts.push(sinceLine(user));
  return parts.join(" · ");
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

// the admin's own password changes on the profile page, with the
// current one
export function canReset(user: UserAccount, meId: string): boolean {
  return user.id !== meId;
}

// the admins who can sign in: a disabled one holds nothing up
export function adminCount(users: UserAccount[]): number {
  return users.filter((u) => u.role === "admin" && !u.disabled).length;
}

// the PATCH body: only what changed, so a stale field is never sent,
// and null when nothing did
export function patchOf(
  user: UserAccount,
  fields: { username: string; fullName: string; email: string; role: Role },
): {
  username?: string;
  fullName?: string;
  email?: string;
  role?: Role;
} | null {
  const body: {
    username?: string;
    fullName?: string;
    email?: string;
    role?: Role;
  } = {};
  const username = fields.username.trim();
  const fullName = fields.fullName.trim();
  const email = fields.email.trim().toLowerCase();
  if (username !== user.username) body.username = username;
  if (fullName !== user.fullName) body.fullName = fullName;
  if (email !== user.email) body.email = email;
  if (fields.role !== user.role) body.role = fields.role;
  return Object.keys(body).length === 0 ? null : body;
}
