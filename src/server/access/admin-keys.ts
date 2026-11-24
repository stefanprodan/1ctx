// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The admin key files, read fresh at every use through the user- reader:
// a key added or rotated needs no restart, and a Kubernetes Secret
// swapped through its symlinks is seen at once. A file is under 100
// bytes and read only for a key sign-in or a key login, so nothing is
// cached. A file that cannot be read is a missing one, and a folder
// that cannot be listed holds none.

import { timingSafeEqual } from "node:crypto";
import { sha256 } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import {
  adminKeyName,
  isAdminKey,
  type UserRow,
  usernameOfKey,
} from "../users/index.ts";
import type { Login } from "./store.ts";

// the user- secrets reader
export type KeyFilesPort = {
  read(name: string): string | null;
  list(): string[];
};

export type AdminKeys = {
  // the username whose file holds this key; null for no file, or for
  // two files holding it, which sign in neither
  match(key: string): string | null;
  // the hash of the key the user's file holds now, null when it holds
  // none or cannot be read
  digestOf(username: string): string | null;
  // the names of files holding one key, by key, for the start's log
  duplicates(): string[][];
};

const sameDigest = (a: string, b: string): boolean =>
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

export function adminKeys(files: KeyFilesPort, log: Log): AdminKeys {
  const readKey = (name: string): string | null => {
    try {
      const value = files.read(name);
      return isAdminKey(value) ? value : null;
    } catch {
      return null;
    }
  };
  // every file's name and its key's hash, the unreadable left out
  const digests = (): { name: string; digest: string }[] => {
    let names: string[];
    try {
      names = files.list();
    } catch {
      // the error names the folder, so only the phrase is logged
      log.warn("admin keys unlisted");
      return [];
    }
    return names.flatMap((name) => {
      const key = readKey(name);
      return key === null ? [] : [{ name, digest: sha256(key) }];
    });
  };
  return {
    match(key) {
      if (!isAdminKey(key)) return null;
      const wanted = sha256(key);
      // every file compared, so the time says nothing of which matched
      const names: string[] = [];
      for (const { name, digest } of digests()) {
        if (sameDigest(digest, wanted)) names.push(name);
      }
      return names.length === 1 ? usernameOfKey(names[0]!) : null;
    },
    digestOf(username) {
      const name = adminKeyName(username);
      if (name === null) return null;
      const key = readKey(name);
      return key === null ? null : sha256(key);
    },
    duplicates() {
      const byDigest = new Map<string, string[]>();
      for (const { name, digest } of digests()) {
        byDigest.set(digest, [...(byDigest.get(digest) ?? []), name]);
      }
      return [...byDigest.values()].filter((names) => names.length > 1);
    },
  };
}

// a login by email holds; a key login only while its user is an enabled
// admin whose file still holds the key it opened with, so a rotation, a
// removed file, a rename, a demote or a disable ends it
export function loginHolds(
  keys: Pick<AdminKeys, "digestOf">,
  login: Pick<Login, "keyDigest">,
  user: UserRow,
): boolean {
  if (login.keyDigest === null) return true;
  if (user.disabled || user.role !== "admin") return false;
  const digest = keys.digestOf(user.username);
  return digest !== null && sameDigest(digest, login.keyDigest);
}
