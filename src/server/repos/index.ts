// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Repositories: git trees a project mounts read-only for bash, each a
// row an admin writes for a team project, or an owner for their
// personal project, public only. The server fetches them; a credential
// a repository names signs only the server's requests.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import { type CredentialsPort, type RepoAuth, repoAuth } from "./check.ts";
import {
  type AccessPort,
  type CapabilitiesPort,
  type ProjectsPort,
  routes,
} from "./routes.ts";
import { type RepoRow, ReposStore } from "./store.ts";

export {
  type Adapter,
  adapter,
  checkRef,
  covers,
  defaultName,
  isCommit,
  normalizeUrl,
  type RepoUrl,
} from "./adapters.ts";
export {
  type CredentialsPort,
  type RepoAuth,
  type RepoCredential,
  type RepoHeader,
  repoAuth,
} from "./check.ts";
export { logCacheSwept, logFetched, logFetchFailed } from "./log.ts";
export {
  parseIgnoreText,
  parseKind,
  parseRef,
  parseRepoName,
  parseRepoUrl,
} from "./parse.ts";
export {
  type RepoFetched,
  type RepoFields,
  type RepoRow,
  ReposStore,
  view,
} from "./store.ts";

export type ReposDeps = {
  db: Db;
  clock: Clock;
  access: AccessPort;
  projects: ProjectsPort;
  credentials: CredentialsPort;
  capabilities: CapabilitiesPort;
};

export type Repos = {
  store: ReposStore;
  routes: RouteDescriptor[];
  byId(id: string): RepoRow | null;
  // a project's, in name order, as the composer's switches list them
  switchable(projectId: string): { id: string; name: string; ref: string }[];
  // the repositories that name a credential, which its delete refuses
  usingCredential(credentialId: string): { projectId: string; name: string }[];
  // at each lookup: the header to send, or no access
  auth(repo: RepoRow): RepoAuth;
};

export function reposArea(deps: ReposDeps): Repos {
  const store = new ReposStore(deps.db);
  return {
    store,
    routes: routes({ ...deps, store }),
    byId: (id) => store.byId(id),
    switchable: (projectId) =>
      store
        .forProject(projectId)
        .map(({ id, name, ref }) => ({ id, name, ref })),
    usingCredential: (credentialId) => store.usingCredential(credentialId),
    auth: (repo) => repoAuth(repo, deps.credentials),
  };
}
