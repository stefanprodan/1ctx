// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP credentials: a key file in the secrets directory, the https
// prefix bash's curl signs with it and the header it goes in, bound to
// team projects by an admin. The key is read when it is needed and
// never leaves this area but to the caller that signs with it.

import type { KeyState } from "../../shared/contracts/credential.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type KeyPort, type KeyRead, keyState, readKey } from "./key.ts";
import { type ProjectsPort, routes, teamName } from "./routes.ts";
import { type CredentialRow, CredentialStore } from "./store.ts";

export {
  type Checked,
  checkHeaderName,
  checkTemplate,
  headerValue,
  isUsableKey,
  normalizePrefix,
  prefixesOverlap,
} from "./check.ts";
export {
  httpKeys,
  type KeyPort,
  type KeyRead,
  keyState,
  MAX_KEY_FILE_BYTES,
  readKey,
} from "./key.ts";
export {
  parseHeader,
  parseKeyName,
  parseMethods,
  parsePrefix,
  parseTemplate,
} from "./parse.ts";
export { type ProjectsPort, summary } from "./routes.ts";
export {
  type CredentialFields,
  type CredentialRow,
  CredentialStore,
} from "./store.ts";

export type CredentialsDeps = {
  db: Db;
  clock: Clock;
  projects: ProjectsPort;
  // the http- key files: their names, sizes and values
  key: KeyPort;
  capabilities: { forget(key: string): void };
};

export type Credentials = {
  store: CredentialStore;
  routes: RouteDescriptor[];
  byId(id: string): CredentialRow | null;
  // the credentials bound to a project, in name order
  forProject(projectId: string): CredentialRow[];
  // a key as it is now: its file sized, read and held to the key's rule
  readKey(keyName: string): KeyRead;
  keyState(keyName: string): KeyState;
  // every credential by name, its prefix and its projects' names, for
  // provisioning's checks
  bindings(): { name: string; prefix: string; projects: string[] }[];
};

export function credentialsArea(deps: CredentialsDeps): Credentials {
  const store = new CredentialStore(deps.db);
  const read = (keyName: string) => readKey(deps.key, keyName);
  return {
    store,
    byId: (id) => store.byId(id),
    forProject: (projectId) => store.forProject(projectId),
    readKey: read,
    keyState: (keyName) => keyState(read(keyName)),
    bindings: () =>
      store.list().map((row) => ({
        name: row.name,
        prefix: row.prefix,
        projects: row.projectIds.flatMap((id) => {
          const name = teamName(deps.projects, id);
          return name === null ? [] : [name];
        }),
      })),
    routes: routes({
      db: deps.db,
      store,
      clock: deps.clock,
      projects: deps.projects,
      keys: () => deps.key.names(),
      readKey: read,
      capabilities: deps.capabilities,
    }),
  };
}
