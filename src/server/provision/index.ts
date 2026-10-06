// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { WebAccess } from "../../shared/web.ts";
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD,
  passwordProblem,
} from "../../shared/words.ts";
import { messageOf } from "../lib/errors.ts";
import { scrubValues } from "../lib/log.ts";
import { ADMIN_SECRET } from "../users/index.ts";
import { apply, type Secret } from "./apply.ts";
import { type Action, type Counts, client, type Handle } from "./client.ts";
import {
  type CredentialsView,
  type Document,
  type Inventory,
  type ProjectDocs,
  preflight,
  type SmtpLogin,
} from "./parse.ts";

export { readSources } from "./input.ts";
export { inventoryOf, projectDocsOf } from "./inventory.ts";
export { loadKnowledge } from "./knowledge.ts";
export { type Document, type Inventory, parse } from "./parse.ts";
export { type ProvisionResult, provisionPaths } from "./run.ts";

export type ProvisionDeps = {
  handle: Handle;
  inventory(): Inventory;
  projectDocs: ProjectDocs;
  credentials: CredentialsView;
  webAccess(): Pick<WebAccess, "mode" | "domains">;
  bootstrap(): Promise<boolean>;
  secret: Secret;
  smtp(): SmtpLogin | null;
};

export type Provision = ReturnType<typeof provisionArea>;

export function provisionArea(deps: ProvisionDeps) {
  const validate = (documents: Document[], secret: Secret = deps.secret) => {
    preflight(
      documents,
      deps.inventory(),
      secret,
      deps.webAccess(),
      deps.projectDocs,
      deps.credentials,
      deps.smtp(),
    );
    const password = secret("user-", ADMIN_SECRET);
    if (password === null || passwordProblem(password) !== null) {
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
      const scrub = (line: string) =>
        scrubValues(line, values, "[redacted]").replace(/[\r\n]/g, " ");
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
          throw new Error(`user/admin: ${messageOf(error)}`);
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
        throw new Error(scrub(messageOf(error)));
      }
    },
  };
}
