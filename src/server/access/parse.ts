// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The request parsers of the access and profile routes. A shared type
// checks the source; these check the JSON a stale tab or a hostile
// client sends, and refuse anything unexpected with a 400.

import type {
  LinkAskRequest,
  LoginRequest,
  UseLinkRequest,
} from "../../shared/api/access.ts";
import type {
  ChangePasswordRequest,
  EmailSettingsRequest,
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
  passwordProblem,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

// a password as typed: anything up to the byte cap. The login parser
// takes any length so an old password stays usable; a new one has a
// floor as well
function password(value: unknown, what: string, min = 1): string {
  if (typeof value !== "string" || passwordProblem(value, min) !== null) {
    throw new BadRequest(
      `${what} must be a string of ${min} to ${MAX_PASSWORD_BYTES} bytes`,
    );
  }
  return value;
}

// a username or an email as typed at sign in: the rule is checked, not
// enforced, so the answer is the same as for an unknown user. Capped at
// an email's length; only an email is lowercased, as it is stored
function loginName(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new BadRequest("username must be a string");
  }
  if (value.length > MAX_EMAIL) {
    throw new BadRequest(`username must be at most ${MAX_EMAIL} characters`);
  }
  return value.includes("@") ? value.toLowerCase() : value;
}

export function parseLogin(body: unknown): LoginRequest {
  const b = fields(body, ["username", "password"]);
  return {
    username: loginName(b.username),
    password: password(b.password, "password"),
  };
}

export function parseLinkAsk(body: unknown): LinkAskRequest {
  const b = fields(body, ["username"]);
  return { username: loginName(b.username) };
}

export function parseLinkUse(body: unknown): UseLinkRequest {
  const b = fields(body, ["password"]);
  return b.password === undefined
    ? {}
    : { password: password(b.password, "password", MIN_PASSWORD) };
}

// newToken()'s shape: 32 bytes as base64url
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function isLinkToken(value: string): boolean {
  return TOKEN.test(value);
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

export function parseEmailSettings(body: unknown): EmailSettingsRequest {
  const b = fields(body, ["fromAgents"]);
  if (typeof b.fromAgents !== "boolean") {
    throw new BadRequest("fromAgents must be a boolean");
  }
  return { fromAgents: b.fromAgents };
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
    "invite",
    "about",
    "disabled",
    "mustChangePassword",
  ]);
  if (!isRole(b.role)) throw new BadRequest("role must be admin or member");
  const parsed: CreateUserRequest = {
    username: parseUsername(b.username),
    fullName: parseFullName(b.fullName),
    email: parseEmail(b.email),
    role: b.role,
    tz: parseTz(b.tz),
  };
  if (b.invite !== undefined) {
    if (b.invite !== true) throw new BadRequest("invite must be true");
    if (b.password !== undefined) {
      throw new BadRequest("password must be left out with an invite");
    }
    // the invite sets the password, so the flag is the invite's own
    if (b.mustChangePassword !== undefined) {
      throw new BadRequest(
        "mustChangePassword must be left out with an invite",
      );
    }
    parsed.invite = true;
  } else {
    parsed.password = password(b.password, "password", MIN_PASSWORD);
  }
  if (b.about !== undefined) parsed.about = parseAbout(b.about);
  if (b.disabled !== undefined) {
    if (typeof b.disabled !== "boolean") {
      throw new BadRequest("disabled must be a boolean");
    }
    parsed.disabled = b.disabled;
  }
  // a disabled user is never emailed, so the invite would not go
  if (parsed.invite === true && parsed.disabled === true) {
    throw new BadRequest("disabled must be left out with an invite");
  }
  if (b.mustChangePassword !== undefined) {
    if (typeof b.mustChangePassword !== "boolean") {
      throw new BadRequest("mustChangePassword must be a boolean");
    }
    parsed.mustChangePassword = b.mustChangePassword;
  }
  return parsed;
}

export function parseUserPatch(body: unknown): UpdateUserRequest {
  const b = fields(body, [
    "username",
    "fullName",
    "about",
    "email",
    "role",
    "tz",
    "disabled",
  ]);
  const patch: UpdateUserRequest = {};
  if (b.username !== undefined) patch.username = parseUsername(b.username);
  if (b.fullName !== undefined) patch.fullName = parseFullName(b.fullName);
  if (b.about !== undefined) patch.about = parseAbout(b.about);
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
