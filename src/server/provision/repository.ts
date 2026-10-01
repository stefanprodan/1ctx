// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A team project's repository as a document: its spec, the checks that
// span documents, and its apply. The repository's own name is
// spec.name, else metadata.name, so two projects may each hold one
// named alike under two document names.

import type { CredentialsResponse } from "../../shared/api/credentials.ts";
import type { ProjectsResponse } from "../../shared/api/projects.ts";
import type { ReposResponse } from "../../shared/api/repos.ts";
import {
  MAX_REPOS_PER_PROJECT,
  type RepoKind,
} from "../../shared/contracts/repo.ts";
import { isName, PERSONAL_PROJECT_NAME } from "../../shared/words.ts";
import { BadRequest } from "../lib/errors.ts";
import {
  adapter,
  covers,
  normalizeUrl,
  parseIgnoreText,
  parseKind,
  parseRef,
  parseRepoName,
  parseRepoUrl,
} from "../repos/index.ts";
import { type Client, difference } from "./client.ts";
import { at, guarded, object, optional } from "./fields.ts";

export type RepositorySpec = {
  project: string;
  url?: string;
  name?: string;
  kind?: RepoKind;
  ref?: string;
  // a credential's name; null takes the held one off
  credential?: string | null;
  ignore?: string;
};

export function repository(value: unknown): RepositorySpec {
  const b = object(
    value,
    ["project", "url", "name", "kind", "ref", "credential", "ignore"],
    "spec",
  );
  const project = at("spec.project", () => {
    if (!isName(b.project)) throw new BadRequest("must be a project name");
    if (b.project === PERSONAL_PROJECT_NAME) {
      throw new BadRequest("cannot name a personal project");
    }
    return b.project;
  });
  return {
    project,
    ...optional<Omit<RepositorySpec, "project">>(b, {
      url: parseRepoUrl,
      name: parseRepoName,
      kind: parseKind,
      ref: parseRef,
      credential: (v) =>
        v === null ? null : guarded(isName, "must be a credential name")(v),
      ignore: parseIgnoreText,
    }),
  };
}

export const repoName = (doc: { name: string; spec: RepositorySpec }) =>
  doc.spec.name ?? doc.name;

// the key a repository is known by among a project's
export const repoKey = (project: string, name: string) => `${project}/${name}`;

type Doc = { source: string; name: string; spec: RepositorySpec };
// the credentials as they will be once applied, by name
export type FinalCredentials = Map<
  string,
  { prefix: string; methods: string[]; projects: string[] }
>;

// across documents: one repository per project and name, at most the
// cap to a project, and a credential that will be bound to the project,
// cover the repository's API and allow GET
export function repositories(
  docs: Doc[],
  live: string[],
  credentials: FinalCredentials,
): void {
  const seen = new Map<string, string>();
  const count = new Map<string, Set<string>>();
  for (const key of live) {
    const project = key.slice(0, key.indexOf("/"));
    const set = count.get(project) ?? new Set();
    set.add(key);
    count.set(project, set);
  }
  for (const doc of docs) {
    const fail = (field: string, message: string): never => {
      throw new Error(
        `${doc.source}: Repository/${doc.name}: spec.${field} ${message}`,
      );
    };
    const name = repoName(doc);
    const key = repoKey(doc.spec.project, name);
    const first = seen.get(key);
    if (first !== undefined) {
      fail(
        "name",
        `${name} is also in ${doc.spec.project} as Repository/${first}`,
      );
    }
    seen.set(key, doc.name);
    const set = count.get(doc.spec.project) ?? new Set();
    set.add(key);
    count.set(doc.spec.project, set);
    if (set.size > MAX_REPOS_PER_PROJECT) {
      fail(
        "project",
        `${doc.spec.project}: a project holds at most ${MAX_REPOS_PER_PROJECT} repositories`,
      );
    }
    const credentialName = doc.spec.credential;
    if (credentialName === undefined || credentialName === null) continue;
    const credential = credentials.get(credentialName);
    if (credential === undefined) {
      fail("credential", "is missing");
      continue;
    }
    if (!credential.projects.includes(doc.spec.project)) {
      fail("credential", `is not bound to ${doc.spec.project}`);
    }
    if (!credential.methods.includes("GET")) {
      fail("credential", "does not allow GET");
    }
    if (doc.spec.url === undefined) continue;
    const parsed = normalizeUrl(doc.spec.url);
    const kind = parsed.ok ? (parsed.value.kind ?? doc.spec.kind) : undefined;
    if (kind === undefined) continue;
    const base = adapter(doc.spec.url, kind).apiBase;
    if (!covers(credential.prefix, base)) {
      fail("credential", `does not cover ${base}`);
    }
  }
}

export async function applyRepository(
  api: Client,
  doc: Doc,
): Promise<"created" | "updated" | "unchanged"> {
  const { projects } = await api.call<ProjectsResponse>("GET", "/api/projects");
  const project = projects.find(
    (row) => row.kind === "team" && row.name === doc.spec.project,
  );
  if (!project) throw new Error(`no such project ${doc.spec.project}`);
  const base = `/api/projects/${project.id}/repos`;
  const { repos } = await api.call<ReposResponse>("GET", base);
  const name = repoName(doc);
  const before = repos.find((row) => row.name === name);
  const { project: _project, name: _name, credential, ...fields } = doc.spec;
  let credentialId: string | null | undefined;
  if (credential === null) credentialId = null;
  if (typeof credential === "string") {
    const found = await api.call<CredentialsResponse>(
      "GET",
      "/api/credentials",
    );
    const row = found.credentials.find((row) => row.name === credential);
    if (!row) throw new Error(`no such reference ${credential}`);
    credentialId = row.id;
  }
  const desired = {
    ...fields,
    ...(credentialId === undefined ? {} : { credentialId }),
  };
  if (!before) {
    await api.call("POST", base, { name, ...desired });
    return "created";
  }
  const patch = difference(before, desired);
  if (!Object.keys(patch).length) return "unchanged";
  await api.call("PATCH", `${base}/${before.id}`, patch);
  return "updated";
}
