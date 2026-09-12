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
import {
  isAbout,
  isFullName,
  isUsername,
  MAX_ABOUT,
  MAX_FULL_NAME,
  MAX_USERNAME,
  MIN_PASSWORD,
  MIN_USERNAME,
} from "../../shared/words.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { MAX_PASSWORD_BYTES } from "../users/index.ts";

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
      `username must be ${MIN_USERNAME} to ${MAX_USERNAME} lowercase letters, digits, dots, dashes or underscores`,
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

export function parseAbout(value: unknown): string {
  if (!isAbout(value)) {
    throw new BadRequest(
      `about must be text of at most ${MAX_ABOUT} characters`,
    );
  }
  return value;
}

export function parseProfile(body: unknown): UpdateProfileRequest {
  const b = fields(body, ["fullName", "about"]);
  return { fullName: parseFullName(b.fullName), about: parseAbout(b.about) };
}

export function parsePasswordChange(body: unknown): ChangePasswordRequest {
  const b = fields(body, ["current", "next"]);
  return {
    current: password(b.current, "current password"),
    next: password(b.next, "new password", MIN_PASSWORD),
  };
}
