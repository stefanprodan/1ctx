// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rules a repository's row is held to with its project and its
// credential at hand: on every save, and the credential's again at each
// lookup, since it may have changed, been unbound or been deleted since.

import type {
  CreateRepoRequest,
  PatchRepoRequest,
} from "../../shared/api/repos.ts";
import type { HttpMethod } from "../../shared/contracts/credential.ts";
import { BadRequest } from "../lib/errors.ts";
import { adapter, covers, defaultName, normalizeUrl } from "./adapters.ts";
import type { RepoFields, RepoRow } from "./store.ts";

// the credential row as repos reads it
export type RepoCredential = {
  id: string;
  name: string;
  keyName: string;
  prefix: string;
  header: string;
  template: string;
  methods: HttpMethod[];
  projectIds: string[];
};

export type CredentialsPort = {
  byId(id: string): RepoCredential | null;
  // the key as it is now, read from its file
  readKey(keyName: string): { ok: true; key: string } | { ok: false };
  headerValue(template: string, key: string): string;
};

export type RepoProject = { id: string; kind: "personal" | "team" };

// the row a create or a change asks for, the held one under it; the
// kind follows from a public host and is asked for on any other
export function desired(
  current: RepoFields | null,
  change: CreateRepoRequest | PatchRepoRequest,
): RepoFields {
  const url = change.url ?? current?.url;
  if (url === undefined) throw new BadRequest("url is required");
  const parsed = normalizeUrl(url);
  if (!parsed.ok) throw new BadRequest(parsed.error);
  const fixed = parsed.value.kind;
  if (fixed !== null && change.kind !== undefined && change.kind !== fixed) {
    throw new BadRequest(`kind must be ${fixed} for ${parsed.value.host}`);
  }
  const kind = fixed ?? change.kind ?? current?.kind;
  if (kind === undefined) {
    throw new BadRequest(`kind is required for ${parsed.value.host}`);
  }
  if (kind === "github" && parsed.value.segments.length !== 2) {
    throw new BadRequest("url must be https://host/owner/name for github");
  }
  const name = change.name ?? current?.name ?? defaultName(parsed.value);
  if (name === null) {
    throw new BadRequest("name is required: the URL's last segment is not one");
  }
  return {
    name,
    url: parsed.value.url,
    kind,
    ref: change.ref ?? current?.ref ?? "",
    credentialId:
      change.credentialId === undefined
        ? (current?.credentialId ?? null)
        : change.credentialId,
    ignore: change.ignore ?? current?.ignore ?? "",
  };
}

// a change to any of these fetches the tree again
export const refetches = (before: RepoFields, after: RepoFields): boolean =>
  before.url !== after.url ||
  before.kind !== after.kind ||
  before.ref !== after.ref ||
  before.credentialId !== after.credentialId ||
  before.ignore !== after.ignore;

// why a credential cannot sign this repository's lookup, null when it can
function refusal(
  projectId: string,
  fields: Pick<RepoFields, "url" | "kind">,
  credential: RepoCredential,
): string | null {
  if (!credential.projectIds.includes(projectId)) {
    return `credential ${credential.name} is not bound to this project`;
  }
  const base = adapter(fields.url, fields.kind).apiBase;
  if (!covers(credential.prefix, base)) {
    return `credential ${credential.name} does not cover ${base}`;
  }
  if (!credential.methods.includes("GET")) {
    return `credential ${credential.name} does not allow GET`;
  }
  return null;
}

// a personal project's repository is public and on a public host; a
// credential must be the project's and cover the repository's API
export function checkRepo(
  project: RepoProject,
  fields: RepoFields,
  credentials: Pick<CredentialsPort, "byId">,
): void {
  if (project.kind === "personal") {
    if (!publicHost(fields.url)) {
      throw new BadRequest(
        "a personal project's repository must be on github.com or gitlab.com",
      );
    }
    if (fields.credentialId !== null) {
      throw new BadRequest(
        "a personal project's repository takes no credential",
      );
    }
    return;
  }
  if (fields.credentialId === null) return;
  const credential = credentials.byId(fields.credentialId);
  if (credential === null) throw new BadRequest("no such credential");
  const why = refusal(project.id, fields, credential);
  if (why !== null) throw new BadRequest(why);
}

function publicHost(url: string): boolean {
  const parsed = normalizeUrl(url);
  return parsed.ok && parsed.value.kind !== null;
}

// the header a lookup or a fetch sends, and the prefix it may go to
export type RepoHeader = { name: string; value: string; prefix: string };

export type RepoAuth =
  | { ok: true; header: RepoHeader | null }
  | { ok: false; error: "no access" };

// at each lookup: the credential still there, bound to the project,
// covering the API and allowing GET, its key readable now
export function repoAuth(
  repo: Pick<RepoRow, "projectId" | "url" | "kind" | "credentialId">,
  credentials: CredentialsPort,
): RepoAuth {
  if (repo.credentialId === null) return { ok: true, header: null };
  const credential = credentials.byId(repo.credentialId);
  if (
    credential === null ||
    refusal(repo.projectId, repo, credential) !== null
  ) {
    return { ok: false, error: "no access" };
  }
  const read = credentials.readKey(credential.keyName);
  if (!read.ok) return { ok: false, error: "no access" };
  return {
    ok: true,
    header: {
      name: credential.header,
      value: credentials.headerValue(credential.template, read.key),
      prefix: credential.prefix,
    },
  };
}
