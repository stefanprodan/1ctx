// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A team project's repository as a document: its spec, the checks that
// span documents, and its apply. The repository's own name is
// spec.name, else metadata.name, so two projects may each hold one
// named alike under two document names.

import type { ProjectsResponse } from "../../shared/api/projects.ts";
import type { ReposResponse } from "../../shared/api/repos.ts";
import {
  MAX_REPOS_PER_PROJECT,
  type RepoKind,
} from "../../shared/contracts/repo.ts";
import { isName, PERSONAL_PROJECT_NAME } from "../../shared/words.ts";
import { parseKeyName } from "../credentials/index.ts";
import { parseName } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";
import {
  parseIgnoreText,
  parseKind,
  parseRef,
  parseRepoUrl,
} from "../repos/index.ts";
import { type Action, type Client, difference } from "./client.ts";
import { at, object, optional } from "./fields.ts";

export type RepositorySpec = {
  project: string;
  url?: string;
  name?: string;
  kind?: RepoKind;
  ref?: string;
  // an http- key file's name; null takes the held one off
  keyFrom?: string | null;
  ignore?: string;
};

export function repository(value: unknown): RepositorySpec {
  const b = object(
    value,
    ["project", "url", "name", "kind", "ref", "keyFrom", "ignore"],
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
      name: parseName,
      kind: parseKind,
      ref: parseRef,
      keyFrom: (v) => (v === null ? null : parseKeyName(v)),
      ignore: parseIgnoreText,
    }),
  };
}

export const repoName = (doc: { name: string; spec: RepositorySpec }) =>
  doc.spec.name ?? doc.name;

// the key a repository is known by among a project's
export const repoKey = (project: string, name: string) => `${project}/${name}`;

type Doc = { source: string; name: string; spec: RepositorySpec };

// across documents: one repository per project and name, and at most the
// cap to a project
export function repositories(docs: Doc[], live: string[]): void {
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
  }
}

export async function applyRepository(api: Client, doc: Doc): Promise<Action> {
  const { projects } = await api.call<ProjectsResponse>("GET", "/api/projects");
  const project = projects.find(
    (row) => row.kind === "team" && row.name === doc.spec.project,
  );
  if (!project) throw new Error(`no such project ${doc.spec.project}`);
  const base = `/api/projects/${project.id}/repos`;
  const { repos } = await api.call<ReposResponse>("GET", base);
  const name = repoName(doc);
  const before = repos.find((row) => row.name === name);
  const { project: _project, name: _name, keyFrom, ...fields } = doc.spec;
  const desired = {
    ...fields,
    ...(keyFrom === undefined ? {} : { keyName: keyFrom }),
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
