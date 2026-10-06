// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CredentialResponse,
  CredentialsResponse,
} from "../../shared/api/credentials.ts";
import { credentialKey } from "../../shared/capabilities.ts";
import {
  type CredentialSummary,
  MAX_CREDENTIALS_PER_PROJECT,
} from "../../shared/contracts/credential.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { prefixesOverlap } from "./check.ts";
import { type KeyRead, keyState } from "./key.ts";
import { parseCreate, parsePatch } from "./parse.ts";
import { type ProjectsPort, teamName } from "./projects.ts";
import type { CredentialRow, CredentialStore } from "./store.ts";

export type RoutesDeps = {
  db: Db;
  store: CredentialStore;
  clock: Clock;
  projects: ProjectsPort;
  // the names of the http- key files, never a value
  keys(): string[];
  readKey(name: string): KeyRead;
  capabilities: { forget(key: string): void };
  repos: ReposPort;
};

// the repositories that read a key file without a credential; built
// later, so a closure
export type ReposPort = {
  usingKeys(): { keyName: string; projectId: string; name: string }[];
};

function summary(
  row: CredentialRow,
  key: CredentialSummary["key"],
  teamName: (id: string) => string | null,
): CredentialSummary {
  return {
    id: row.id,
    name: row.name,
    keyName: row.keyName,
    key,
    prefix: row.prefix,
    header: row.header,
    template: row.template,
    methods: row.methods,
    projects: row.projectIds
      .flatMap((id) => {
        const name = teamName(id);
        return name === null ? [] : [{ id, name }];
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const show = (row: CredentialRow) =>
    summary(row, keyState(deps.readKey(row.keyName)), (id) =>
      teamName(deps.projects, id),
    );
  const response = (row: CredentialRow): CredentialResponse => ({
    credential: show(row),
  });
  const teamProjects = (ids: string[]) => {
    for (const id of ids) {
      if (teamName(deps.projects, id) === null) {
        throw new BadRequest(`no such team project ${id}`);
      }
    }
    return ids;
  };
  // the credential as written, against every other bound to its projects
  const checkBindings = (id: string) => {
    const row = deps.store.byId(id)!;
    for (const projectId of row.projectIds) {
      const others = deps.store
        .forProject(projectId)
        .filter((other) => other.id !== id);
      const project = teamName(deps.projects, projectId);
      if (others.length >= MAX_CREDENTIALS_PER_PROJECT) {
        throw new Conflict(
          `${project} has ${MAX_CREDENTIALS_PER_PROJECT} credentials`,
        );
      }
      const overlap = others.find((other) =>
        prefixesOverlap(other.prefix, row.prefix),
      );
      if (overlap !== undefined) {
        throw new Conflict(`the prefix overlaps ${overlap.name} in ${project}`);
      }
    }
    return row;
  };
  return [
    {
      method: "GET",
      path: "/api/credentials",
      policy: "admin",
      handle() {
        const using = deps.repos.usingKeys();
        const body: CredentialsResponse = {
          credentials: deps.store.list().map(show),
          keys: deps.keys().map((name) => ({
            name,
            usable: deps.readKey(name).ok,
            repos: using.flatMap((repo) => {
              const project = teamName(deps.projects, repo.projectId);
              return repo.keyName === name && project !== null
                ? [`${project}/${repo.name}`]
                : [];
            }),
          })),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/credentials",
      policy: "admin",
      async handle(req) {
        const { name, projectIds, ...fields } = parseCreate(
          await jsonBody(req),
        );
        const row = transact(deps.db, () => {
          if (deps.store.byName(name) !== null) {
            throw new Conflict(`a credential named ${name} exists`);
          }
          const id = deps.store.create(name, fields, deps.clock());
          deps.store.setProjects(id, teamProjects(projectIds));
          return { result: checkBindings(id) };
        });
        return json(response(row), 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/credentials/:id",
      policy: "admin",
      async handle(req, ctx) {
        const change = parsePatch(await jsonBody(req));
        const row = transact(deps.db, () => {
          const before = deps.store.byId(ctx.params.id);
          if (before === null) throw new NotFound("no such credential");
          const { projectIds, ...fields } = change;
          deps.store.update(before.id, { ...before, ...fields }, deps.clock());
          if (projectIds !== undefined) {
            deps.store.setProjects(before.id, teamProjects(projectIds));
          }
          return { result: checkBindings(before.id) };
        });
        return json(response(row));
      },
    },
    {
      method: "DELETE",
      path: "/api/credentials/:id",
      policy: "admin",
      handle(_req, ctx) {
        transact(deps.db, () => {
          if (!deps.store.delete(ctx.params.id)) {
            throw new NotFound("no such credential");
          }
          deps.capabilities.forget(credentialKey(ctx.params.id));
          return { result: undefined };
        });
        return new Response(null, { status: 204 });
      },
    },
  ];
}
