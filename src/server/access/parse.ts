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
  CreateAccessKeyRequest,
  EmailSettingsRequest,
  UpdateProfileRequest,
} from "../../shared/api/profile.ts";
import type {
  CreateUserRequest,
  UpdateUserRequest,
} from "../../shared/api/users.ts";
import {
  ACCESS_KEY_DAYS,
  ACCESS_KEY_SCOPES,
} from "../../shared/contracts/access-key.ts";
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
  MAX_USERNAME,
  MIN_USERNAME,
  NAME_CHARACTERS,
} from "../../shared/words.ts";
import { fields, parseName } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import { isAdminKey } from "../users/index.ts";

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

// the route answers any refusal here with its one 401
export function parseLogin(body: unknown): LoginRequest {
  const b = fields(body, ["key"]);
  if (!isAdminKey(b.key)) throw new BadRequest("key must be an admin key");
  return { key: b.key };
}

export function parseLinkAsk(body: unknown): LinkAskRequest {
  const b = fields(body, ["username"]);
  return { username: loginName(b.username) };
}

export function parseLinkUse(body: unknown): UseLinkRequest {
  fields(body, []);
  return {};
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

export function parseAccessKey(body: unknown): CreateAccessKeyRequest {
  const b = fields(body, ["name", "scope", "projectIds", "days"]);
  // the agent name rule, so a key reads as a handle in `@user via <key>`
  const name = parseName(b.name);
  const scope = ACCESS_KEY_SCOPES.find((value) => value === b.scope);
  if (scope === undefined) throw new BadRequest("scope must be read or write");
  const days = ACCESS_KEY_DAYS.find((value) => value === b.days);
  if (days === undefined) throw new BadRequest("days must be 30, 90 or 365");
  const ids = b.projectIds;
  if (
    ids !== null &&
    (!Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every(
        (id): id is string =>
          typeof id === "string" && /^[0-9a-z]{1,32}$/.test(id),
      ) ||
      new Set(ids).size !== ids.length)
  ) {
    throw new BadRequest("projectIds must be null or distinct project ids");
  }
  return { name, scope, projectIds: ids, days };
}

export function parseNewUser(body: unknown): CreateUserRequest {
  const b = fields(body, [
    "username",
    "fullName",
    "email",
    "role",
    "tz",
    "invite",
    "about",
    "disabled",
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
    parsed.invite = true;
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
