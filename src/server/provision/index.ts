// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { WebAccess } from "../../shared/web.ts";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD } from "../../shared/words.ts";
import { type Action, apply, type Counts, type Secret } from "./apply.ts";
import { client, type Handle } from "./client.ts";
import { type Document, type Inventory, preflight } from "./parse.ts";

export { readSources } from "./input.ts";
export { type Document, type Inventory, parse } from "./parse.ts";

export type ProvisionDeps = {
  handle: Handle;
  inventory(): Inventory;
  webAccess(): Pick<WebAccess, "mode" | "domains">;
  bootstrap(): Promise<boolean>;
  secret: Secret;
};

export type Provision = ReturnType<typeof provisionArea>;

export function provisionArea(deps: ProvisionDeps) {
  const validate = (documents: Document[], secret: Secret = deps.secret) => {
    preflight(documents, deps.inventory(), secret, deps.webAccess());
    const password = secret("user-", "user-admin");
    if (
      password === null ||
      password.length < MIN_PASSWORD ||
      new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES
    ) {
      throw new Error(
        `user/admin: user-admin.key must hold ${MIN_PASSWORD} to ${MAX_PASSWORD_BYTES} bytes`,
      );
    }
    return password;
  };
  return {
    validate,
    async apply(
      documents: Document[],
      output: (line: string) => void = console.log,
    ) {
      const values = new Set<string>();
      const secret: Secret = (kind, name) => {
        const value = deps.secret(kind, name);
        if (value !== null) values.add(value);
        return value;
      };
      const scrub = (line: string) => {
        let result = line;
        for (const value of [...values].sort((a, b) => b.length - a.length)) {
          result = result.replaceAll(value, "[redacted]");
        }
        return result.replace(/[\r\n]/g, " ");
      };
      const counts: Counts = { created: 0, updated: 0, unchanged: 0 };
      const report = (action: Action, kind: string, name: string) => {
        counts[action]++;
        output(scrub(`${action} ${kind.toLowerCase()}/${name}`));
      };
      try {
        // Validation precedes even the login row and the first admin.
        const password = validate(documents, secret);
        // not an object in the file, so it is said plainly and counted
        // nowhere; its own document, if there is one, reports itself
        if (await deps.bootstrap()) {
          output("bootstrapped user/admin from user-admin.key");
        }
        const api = client(deps.handle);
        try {
          await api.call("POST", "/api/login", { username: "admin", password });
        } catch (error) {
          throw new Error(
            `user/admin: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          await apply(api, documents, secret, report);
        } finally {
          await api.call("POST", "/api/logout");
        }
        output(
          `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`,
        );
        return counts;
      } catch (error) {
        throw new Error(
          scrub(error instanceof Error ? error.message : String(error)),
        );
      }
    },
  };
}
