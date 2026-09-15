// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The request parsers of the access and profile routes. A shared type
// checks the source; these check the JSON a stale tab or a hostile
// client sends, and refuse anything unexpected with a 400.

import type { LoginRequest } from "../../shared/api/access.ts";
import type {
  ChangePasswordRequest,
  UpdateProfileRequest,
} from "../../shared/api/profile.ts";
import type {
  CreateUserRequest,
  ResetPasswordRequest,
  UpdateUserRequest,
} from "../../shared/api/users.ts";
import {
  isAbout,
  isEmail,
  isFullName,
  isRole,
  isTimeZone,
  isUsername,
  MAX_ABOUT,
  MAX_EMAIL,
  MAX_FULL_NAME,
  MAX_PASSWORD_BYTES,
  MAX_USERNAME,
  MIN_PASSWORD,
  MIN_USERNAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

// a password as typed: anything up to the byte cap. The login parser
// takes any length so an old password stays usable; a new one has a
// floor as well
function password(value: unknown, what: string, min = 1): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    bytes(value) > MAX_PASSWORD_BYTES
  ) {
    throw new BadRequest(
      `${what} must be a string of ${min} to ${MAX_PASSWORD_BYTES} bytes`,
    );
  }
  return value;
}

export function parseLogin(body: unknown): LoginRequest {
  const b = fields(body, ["username", "password"]);
  // the login form takes what was typed; the rule is checked, not
  // enforced, so the answer is the same 401 as for an unknown user
  if (typeof b.username !== "string" || b.username === "") {
    throw new BadRequest("username must be a string");
  }
  if (b.username.length > MAX_USERNAME) {
    throw new BadRequest(
      `username must be ${MIN_USERNAME} to ${MAX_USERNAME} characters`,
    );
  }
  return { username: b.username, password: password(b.password, "password") };
}

export function parseUsername(value: unknown): string {
  if (!isUsername(value)) {
    throw new BadRequest(
      `username must be ${MIN_USERNAME} to ${MAX_USERNAME} ${NAME_CHARACTERS}`,
    );
  }
  return value;
}

export function parseFullName(value: unknown): string {
  if (!isFullName(value)) {
    throw new BadRequest(
      `full name must be 1 to ${MAX_FULL_NAME} characters on one line, no leading or trailing spaces`,
    );
  }
  return value;
}

export function parseEmail(value: unknown): string {
  if (!isEmail(value)) {
    throw new BadRequest(
      `email must be 3 to ${MAX_EMAIL} characters with a domain`,
    );
  }
  return value.toLowerCase();
}

export function parseAbout(value: unknown): string {
  if (!isAbout(value)) {
    throw new BadRequest(
      `about must be text of at most ${MAX_ABOUT} characters`,
    );
  }
  return value;
}

export function parseTz(value: unknown): string {
  if (!isTimeZone(value)) {
    throw new BadRequest("time zone must be an IANA zone name");
  }
  return value;
}

export function parseProfile(body: unknown): UpdateProfileRequest {
  const b = fields(body, ["fullName", "about", "tz"]);
  return {
    fullName: parseFullName(b.fullName),
    about: parseAbout(b.about),
    tz: parseTz(b.tz),
  };
}

export function parsePasswordChange(body: unknown): ChangePasswordRequest {
  const b = fields(body, ["current", "next"]);
  return {
    current: password(b.current, "current password"),
    next: password(b.next, "new password", MIN_PASSWORD),
  };
}

export function parseNewUser(body: unknown): CreateUserRequest {
  const b = fields(body, [
    "username",
    "fullName",
    "email",
    "role",
    "tz",
    "password",
  ]);
  if (!isRole(b.role)) throw new BadRequest("role must be admin or member");
  return {
    username: parseUsername(b.username),
    fullName: parseFullName(b.fullName),
    email: parseEmail(b.email),
    role: b.role,
    tz: parseTz(b.tz),
    password: password(b.password, "password", MIN_PASSWORD),
  };
}

export function parseUserPatch(body: unknown): UpdateUserRequest {
  const b = fields(body, [
    "username",
    "fullName",
    "email",
    "role",
    "tz",
    "disabled",
  ]);
  const patch: UpdateUserRequest = {};
  if (b.username !== undefined) patch.username = parseUsername(b.username);
  if (b.fullName !== undefined) patch.fullName = parseFullName(b.fullName);
  if (b.email !== undefined) patch.email = parseEmail(b.email);
  if (b.tz !== undefined) patch.tz = parseTz(b.tz);
  if (b.role !== undefined) {
    if (!isRole(b.role)) throw new BadRequest("role must be admin or member");
    patch.role = b.role;
  }
  if (b.disabled !== undefined) {
    if (typeof b.disabled !== "boolean") {
      throw new BadRequest("disabled must be a boolean");
    }
    patch.disabled = b.disabled;
  }
  if (Object.keys(patch).length === 0) {
    throw new BadRequest("at least one field is required");
  }
  return patch;
}

export function parseUserPassword(body: unknown): ResetPasswordRequest {
  const b = fields(body, ["password"]);
  return { password: password(b.password, "password", MIN_PASSWORD) };
}
