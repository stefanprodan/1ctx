// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository row's rules: at each save, and the key's at each lookup.

import type {
  CreateRepoRequest,
  PatchRepoRequest,
} from "../../shared/api/repos.ts";
import { BadRequest } from "../lib/errors.ts";
import { adapter, defaultName, normalizeUrl } from "./adapters.ts";
import type { RepoFields, RepoRow } from "./store.ts";

export type KeysPort = {
  // the http- key as it is now, read from its file
  readKey(
    keyName: string,
  ): { ok: true; key: string } | { ok: false; reason: "missing" | "unusable" };
};

export type RepoProject = { id: string; kind: "personal" | "team" };

const PERSONAL_HOST =
  "a personal project's repository must be on github.com or gitlab.com";

// the row a create or a change asks for, the held one under it; the
// kind follows from a public host and is asked for on any other. A
// personal project's repository is public and on a public host; a key a
// save names must be a usable file, while one that goes missing later
// only fails the lookup
export function checkFields(
  project: RepoProject,
  current: RepoFields | null,
  change: CreateRepoRequest | PatchRepoRequest,
  keys: KeysPort,
): RepoFields {
  const personal = project.kind === "personal";
  const url = change.url ?? current?.url;
  if (url === undefined) throw new BadRequest("url is required");
  const parsed = normalizeUrl(url);
  if (!parsed.ok) throw new BadRequest(parsed.error);
  const fixed = parsed.value.kind;
  // before the kind, which a personal project's form never asks
  if (personal && fixed === null) throw new BadRequest(PERSONAL_HOST);
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
  const fields: RepoFields = {
    name,
    url: parsed.value.url,
    kind,
    ref: change.ref ?? current?.ref ?? "",
    keyName:
      change.keyName === undefined
        ? (current?.keyName ?? null)
        : change.keyName,
    ignore: change.ignore ?? current?.ignore ?? "",
  };
  const keyName = fields.keyName;
  if (personal) {
    if (keyName !== null) {
      throw new BadRequest("a personal project's repository takes no key");
    }
  } else if (keyName !== null && keyName !== current?.keyName) {
    const read = keys.readKey(keyName);
    if (!read.ok) throw new BadRequest(`keyName ${keyName} is ${read.reason}`);
  }
  return fields;
}

// a change to any of these fetches the tree again
export const refetches = (before: RepoFields, after: RepoFields): boolean =>
  before.url !== after.url ||
  before.kind !== after.kind ||
  before.ref !== after.ref ||
  before.keyName !== after.keyName ||
  before.ignore !== after.ignore;

// the header a lookup or a fetch sends, and the API base it may go to
export type RepoHeader = { name: string; value: string; prefix: string };

export type RepoAuth =
  | { ok: true; header: RepoHeader | null }
  | { ok: false; error: "no access" };

// at each lookup: the key read now, sent only under the repository's API
// base; both hosts' APIs take a token as a bearer
export function repoAuth(
  repo: Pick<RepoRow, "url" | "kind" | "keyName">,
  keys: KeysPort,
): RepoAuth {
  if (repo.keyName === null) return { ok: true, header: null };
  const read = keys.readKey(repo.keyName);
  if (!read.ok) return { ok: false, error: "no access" };
  return {
    ok: true,
    header: {
      name: "authorization",
      value: `Bearer ${read.key}`,
      prefix: adapter(repo.url, repo.kind).apiBase,
    },
  };
}
