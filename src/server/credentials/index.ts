// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// HTTP credentials: an http- key file curl signs with under a prefix.

import type { KeyState } from "../../shared/contracts/credential.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type KeyPort, type KeyRead, keyState, readKey } from "./key.ts";
import { type ProjectsPort, teamName } from "./projects.ts";
import { type ReposPort, routes } from "./routes.ts";
import { type CredentialRow, CredentialStore } from "./store.ts";

export { headerValue, prefixesOverlap } from "./check.ts";
export { httpKeys, type KeyRead, MAX_KEY_FILE_BYTES, readKey } from "./key.ts";
export {
  parseHeader,
  parseKeyName,
  parseMethods,
  parsePrefix,
  parseTemplate,
} from "./parse.ts";
export { type CredentialRow, CredentialStore } from "./store.ts";

export type CredentialsDeps = {
  db: Db;
  clock: Clock;
  projects: ProjectsPort;
  key: KeyPort;
  capabilities: { forget(key: string): void };
  repos: ReposPort;
};

export type Credentials = {
  store: CredentialStore;
  routes: RouteDescriptor[];
  byId(id: string): CredentialRow | null;
  // in name order
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
      repos: deps.repos,
    }),
  };
}
