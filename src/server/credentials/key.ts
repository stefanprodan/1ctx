// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A credential's key, read from its http- file at the moment it is
// needed, and held to the key's rule each time.

import { KEY_BYTES, type KeyState } from "../../shared/contracts/credential.ts";
import { isUsableKey } from "./check.ts";

// what the secrets port may read of an http- file: the key and room for
// the line end and spaces it trims. The port sizes the file first and
// answers null past this, since it reads a file whole
export const MAX_KEY_FILE_BYTES = KEY_BYTES.max + 64;

export type KeyPort = {
  // the value trimmed, null when the file is absent, empty or too large
  read(name: string): string | null;
  // the http- file names, never a value
  names(): string[];
};

export type KeyRead =
  | { ok: true; key: string }
  | { ok: false; reason: Exclude<KeyState, "ok"> };

export function readKey(port: KeyPort, name: string): KeyRead {
  const value = port.read(name);
  if (value === null) {
    // a listed file the port would not read is empty or too large
    return {
      ok: false,
      reason: port.names().includes(name) ? "unusable" : "missing",
    };
  }
  return isUsableKey(value)
    ? { ok: true, key: value }
    : { ok: false, reason: "unusable" };
}

export const keyState = (read: KeyRead): KeyState =>
  read.ok ? "ok" : read.reason;

// the http- files over the secrets port, and the port again for a scrub
// list, where an http- key that fails its rule is never sent, so never
// scrubbed
export function httpKeys<Kind extends string>(secrets: {
  secret(kind: Kind | "http-", name: string): string | null;
  secretNames?: (kind: "http-") => string[];
}): KeyPort & { scrubbed(kind: Kind | "http-", name: string): string | null } {
  const port: KeyPort = {
    read: (name) => secrets.secret("http-", name),
    names: () => secrets.secretNames?.("http-") ?? [],
  };
  return {
    ...port,
    scrubbed(kind, name) {
      if (kind !== "http-") return secrets.secret(kind, name);
      const read = readKey(port, name);
      return read.ok ? read.key : null;
    },
  };
}
