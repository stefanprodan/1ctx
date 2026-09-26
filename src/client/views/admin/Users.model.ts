// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the users page shows and what its forms check before they call:
// an empty field, a malformed email and a mistyped password, caught
// without a round trip. The username rule is the server's alone.

import type { UpdateUserRequest } from "../../../shared/api/users.ts";
import type { UserAccount } from "../../../shared/contracts/user.ts";
import {
  isEmail,
  MAX_EMAIL,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD,
  type Role,
} from "../../../shared/words.ts";
import { sinceLine } from "../../lib/format.ts";
import type { Problem } from "../../lib/save.ts";

export const ROLE_CHOICES: { value: Role; label: string; text: string }[] = [
  {
    value: "member",
    label: "Member",
    text: "Works in the projects they belong to.",
  },
  {
    value: "admin",
    label: "Admin",
    text: "Also manages users, projects and agents.",
  },
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

// a first password, or a reset: typed twice, since nobody sees it
export function newPasswordProblem(next: string, again: string): string | null {
  if (next.length < MIN_PASSWORD)
    return `The password needs at least ${MIN_PASSWORD} characters`;
  if (new TextEncoder().encode(next).length > MAX_PASSWORD_BYTES)
    return `The password needs at most ${MAX_PASSWORD_BYTES} bytes`;
  if (again !== next) return "The two passwords differ";
  return null;
}

// the same checks pinned to the field to fix: a mismatch is the second
// box, anything else the first
export function newPasswordFieldProblem(
  next: string,
  again: string,
  names: { next: string; again: string },
): Problem | null {
  const error = newPasswordProblem(next, again);
  if (error === null) return null;
  return { error, field: error.includes("differ") ? names.again : names.next };
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
