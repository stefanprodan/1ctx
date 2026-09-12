// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Secrets are files: one bare value per file in the secrets directory,
// named by the thing that uses it. Local mode lets the admin page write
// them later; mounted mode is a Kubernetes Secret and read-only. Nothing
// here logs or returns a value to a route; a holder reads what it needs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type SecretsMode = "local" | "mounted";

export type Secrets = {
  readonly dir: string;
  readonly mode: SecretsMode;
  // the bare value with surrounding whitespace removed, or null when the
  // file is absent or empty
  read(name: string): string | null;
  has(name: string): boolean;
};

// ../secrets next to the binary; .preview/secrets when run from source
export function defaultDir(main: string, execPath: string): string {
  const fromSource = main.endsWith(".ts");
  return fromSource
    ? resolve(dirname(main), "..", "..", ".preview", "secrets")
    : resolve(dirname(execPath), "..", "secrets");
}

export function secrets(dir: string, mode: SecretsMode): Secrets {
  const pathOf = (name: string) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`bad secret name`);
    return join(dir, `${name}.key`);
  };
  return {
    dir,
    mode,
    read(name) {
      const path = pathOf(name);
      if (!existsSync(path)) return null;
      const value = readFileSync(path, "utf8").trim();
      return value === "" ? null : value;
    },
    has(name) {
      return existsSync(pathOf(name));
    },
  };
}
