// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Secrets are files: one bare value per file in the secrets directory,
// named by the thing that uses it. Local mode lets the admin page write
// them later; mounted mode is a Kubernetes Secret and read-only. Nothing
// here logs or returns a value to a route; a holder reads what it needs.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSecretName, SECRET_KINDS } from "../../shared/words.ts";

export type SecretsMode = "local" | "mounted";

export type Secrets = {
  readonly dir: string;
  readonly mode: SecretsMode;
  // the bare value with surrounding whitespace removed, or null when the
  // file is absent, empty or not a regular file, or larger than maxBytes,
  // which is checked before the file is read
  read(kind: string, name: string, maxBytes?: number): string | null;
  has(kind: string, name: string): boolean;
  // the names alone, so a page can offer a pick without a value
  // crossing
  list(kind: string): string[];
};

// ../secrets next to the binary; .preview/secrets when run from source
export function defaultDir(main: string, execPath: string): string {
  const fromSource = main.endsWith(".ts");
  return fromSource
    ? resolve(dirname(main), "..", "..", ".preview", "secrets")
    : resolve(dirname(execPath), "..", "secrets");
}

export function secrets(dir: string, mode: SecretsMode): Secrets {
  const pathOf = (kind: string, name: string) => {
    if (!isSecretName(kind, name)) throw new Error("bad secret name");
    return join(dir, `${name}.key`);
  };
  return {
    dir,
    mode,
    read(kind, name, maxBytes = Number.POSITIVE_INFINITY) {
      const path = pathOf(kind, name);
      // a FIFO or a device sizes as 0 and could block the read
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile() || stat.size > maxBytes) {
        return null;
      }
      const value = readFileSync(path, "utf8").trim();
      return value === "" ? null : value;
    },
    has(kind, name) {
      return existsSync(pathOf(kind, name));
    },
    list(kind) {
      if (!SECRET_KINDS.some((known) => known === kind)) {
        throw new Error("bad secret kind");
      }
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((file) => file.endsWith(".key"))
        .map((file) => file.slice(0, -".key".length))
        .filter((name) => isSecretName(kind, name))
        .sort();
    },
  };
}
