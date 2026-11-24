// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// `1ctx admin-key`: a fresh admin key in its file, owner-only and never
// over an existing one, since that file may hold a key in use.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isUsername } from "../../shared/words.ts";
import { adminKeyName, newAdminKey } from "./rules.ts";

export type AdminKeyFile =
  | { ok: true; key: string; path: string | null }
  | { ok: false; error: string };

// the key, written to dir unless dir is null (printed instead)
export function makeAdminKey(
  username: string,
  dir: string | null,
): AdminKeyFile {
  const name = isUsername(username) ? adminKeyName(username) : null;
  if (name === null) {
    return {
      ok: false,
      error: `${username} has no key file name: one takes only lowercase letters, digits and dashes`,
    };
  }
  const key = newAdminKey();
  if (dir === null) return { ok: true, key, path: null };
  const path = join(dir, `${name}.key`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, error: `${path} exists; move it aside first` };
    }
    throw error;
  }
  try {
    writeSync(fd, `${key}\n`);
  } finally {
    closeSync(fd);
  }
  return { ok: true, key, path };
}
