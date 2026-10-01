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
import type { Log } from "../lib/log.ts";
import { type FreeSpace, RepoCache } from "./cache.ts";
import { type CredentialsPort, type RepoAuth, repoAuth } from "./check.ts";
import type { JobRunner } from "./jobs.ts";
import {
  Mounts,
  type Prepared,
  type PrepareOptions,
  type RepoLimits,
} from "./mounts.ts";
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
export { type JobRunner, threadJobs, workerJobs } from "./jobs.ts";
export {
  REPO_FETCH_MS,
  REPO_LOOKUP_MS,
  REPO_STALL_MS,
  REPO_WAIT_MS,
} from "./limits.ts";
export { logCacheSwept, logFetched, logFetchFailed } from "./log.ts";
export {
  type Prepared,
  type PrepareOptions,
  type RepoLimits,
  type RepoMount,
  type RepoNotice,
  sourceOf,
} from "./mounts.ts";
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
  // the cache directory; none, and nothing is fetched
  cacheDir: string | null;
  // the fetch worker, or a job on this thread in a test
  jobs: JobRunner;
  // the lookups' requests
  fetch: typeof fetch;
  limits(): RepoLimits;
  log: Log;
  // a process slot, shared with commands
  acquire(signal: AbortSignal): Promise<() => void>;
  userAgent: string;
  // the cache volume's free bytes; a test passes its own
  freeSpace?: FreeSpace;
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
  // at a turn's start: the trees of the project's repositories on, each
  // held until release(), and a notice for each one not mounted
  prepare(projectId: string, options?: PrepareOptions): Promise<Prepared>;
  // at startup: fetching rows back to pending, the cache indexed and
  // its tmp/ cleared; null without a cache directory
  start(): { dir: string; trees: number; bytes: number } | null;
  // hourly: the cache kept under repoCacheBytes
  sweep(): void;
  // the drain: every fetch ends
  close(): void;
};

export function reposArea(deps: ReposDeps): Repos {
  const store = new ReposStore(deps.db);
  const auth = (repo: RepoRow) => repoAuth(repo, deps.credentials);
  const cache =
    deps.cacheDir === null
      ? null
      : new RepoCache(deps.cacheDir, deps.clock, deps.freeSpace);
  const mounts = new Mounts({
    store,
    cache,
    jobs: deps.jobs,
    fetch: deps.fetch,
    auth,
    limits: deps.limits,
    clock: deps.clock,
    log: deps.log,
    acquire: deps.acquire,
    userAgent: deps.userAgent,
  });
  return {
    store,
    routes: routes({
      ...deps,
      store,
      changed: (repoId) => mounts.refresh(repoId),
    }),
    byId: (id) => store.byId(id),
    switchable: (projectId) =>
      store
        .forProject(projectId)
        .map(({ id, name, ref }) => ({ id, name, ref })),
    usingCredential: (credentialId) => store.usingCredential(credentialId),
    auth,
    prepare: (projectId, options) => mounts.prepare(projectId, options),
    start() {
      const started = mounts.start();
      return started === null || cache === null
        ? null
        : { dir: cache.dir, ...started };
    },
    sweep: () => mounts.sweep(),
    close: () => mounts.close(),
  };
}
