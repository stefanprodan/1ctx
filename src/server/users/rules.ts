// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin key: the file user-<username>.key holding 1ctx-admin- and
// 32 random bytes as base64url. The prefix is required, so the log
// scrub masks a key by its shape and it never reads as an access key.

import { isSecretName } from "../../shared/words.ts";
import { newToken } from "../lib/ids.ts";

export const ADMIN_KEY_PREFIX = "1ctx-admin-";
export const ADMIN_KEY_KIND = "user-";

const ADMIN_KEY = /^1ctx-admin-[A-Za-z0-9_-]{43}$/;

export function isAdminKey(value: unknown): value is string {
  return typeof value === "string" && ADMIN_KEY.test(value);
}

export function newAdminKey(): string {
  return `${ADMIN_KEY_PREFIX}${newToken()}`;
}

// the key file's name for a username, null when a secret name cannot
// spell it (an underscore, say), so such an admin has no key
export function adminKeyName(username: string): string | null {
  const name = `${ADMIN_KEY_KIND}${username}`;
  return isSecretName(ADMIN_KEY_KIND, name) ? name : null;
}

// the username a key file names
export const usernameOfKey = (name: string): string =>
  name.slice(ADMIN_KEY_KIND.length);
