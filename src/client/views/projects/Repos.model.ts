// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { CredentialKey } from "../../../shared/api/credentials.ts";
import type {
  CreateRepoRequest,
  PatchRepoRequest,
  RepoView,
} from "../../../shared/api/repos.ts";
import {
  MAX_REPOS_PER_PROJECT,
  PUBLIC_REPO_HOSTS,
  type RepoKind,
} from "../../../shared/contracts/repo.ts";
import { isName } from "../../../shared/words.ts";
import { commas, pluralCommas, sizeWords } from "../../lib/format.ts";
import type { Option } from "../../ui/Select.model.ts";
import { keyOptions } from "../admin/Credentials.model.ts";

export type RepoDraft = {
  url: string;
  name: string;
  ref: string;
  // "" until picked, asked only for a host that does not fix it
  kind: RepoKind | "";
  // the http- key file, "" for none
  keyName: string;
  ignore: string;
};

export const draftOf = (row: RepoView | null): RepoDraft => ({
  url: row?.url ?? "",
  name: row?.name ?? "",
  ref: row?.ref ?? "",
  kind: row?.kind ?? "",
  keyName: row?.keyName ?? "",
  ignore: row?.ignore ?? "",
});

// the open form: a new repository, the row as it was when Change
// opened it, or none
export type OpenRepo = RepoView | "new" | null;

// a row gone from the list, deleted in another tab, closes its form
export function openOf(open: OpenRepo, list: readonly RepoView[]): OpenRepo {
  if (open === null || open === "new") return open;
  return list.some((r) => r.id === open.id) ? open : null;
}

export const KIND_OPTIONS: { value: RepoKind; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

export const URL_PLACEHOLDER = "https://github.com/owner/name";
// one default from each kind the hint names, the box's four lines
export const IGNORE_PLACEHOLDER = ["*.png", "*.mp4", "*.woff2", "*.zip"].join(
  "\n",
);
export const IGNORE_HINT =
  "In .gitignore format. Replaces the default list of images, media, fonts, zip archives and binaries.";
export const PUBLIC_HINT =
  "Read-only clones of public repositories for agents.";
export const TEAM_HINT = "Read-only clones for agents, managed by admins.";
export const CAP_LINE = `At most ${MAX_REPOS_PER_PROJECT} repositories.`;

// the Settings tab's side text, the same for an admin and a member
export const reposHint = (personal: boolean): string =>
  personal ? PUBLIC_HINT : TEAM_HINT;

// the typed URL's host, lowercased, null while it is no https URL
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" && parsed.hostname !== ""
      ? parsed.host.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

const fixedKind = (host: string): RepoKind | null =>
  (PUBLIC_REPO_HOSTS as Record<string, RepoKind | undefined>)[host] ?? null;

// a team project's repository on a host that is neither public one
export function asksKind(url: string, personal: boolean): boolean {
  if (personal) return false;
  const host = hostOf(url);
  return host !== null && fixedKind(host) === null;
}

// the name the server gives an empty one: the URL's last segment, as
// adapters.ts derives it; only a placeholder, the server decides
export function nameOf(url: string): string {
  const host = hostOf(url);
  if (host === null) return "";
  const last = new URL(url.trim()).pathname
    .split("/")
    .filter((part) => part !== "")
    .at(-1);
  if (last === undefined) return "";
  const name = last
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return isName(name) ? name : "";
}

export function createBody(d: RepoDraft, personal: boolean): CreateRepoRequest {
  const body: CreateRepoRequest = { url: d.url.trim() };
  if (d.name.trim() !== "") body.name = d.name.trim();
  if (d.ref.trim() !== "") body.ref = d.ref.trim();
  if (asksKind(d.url, personal) && d.kind !== "") body.kind = d.kind;
  if (!personal && d.keyName !== "") body.keyName = d.keyName;
  if (d.ignore.trim() !== "") body.ignore = d.ignore;
  return body;
}

// only what changed, so a rename alone never fetches again
export function patchBody(
  d: RepoDraft,
  row: RepoView,
  personal: boolean,
): PatchRepoRequest | null {
  const body: PatchRepoRequest = {};
  const url = d.url.trim();
  if (url !== row.url) body.url = url;
  const name = d.name.trim();
  if (name !== "" && name !== row.name) body.name = name;
  if (d.ref.trim() !== row.ref) body.ref = d.ref.trim();
  if (asksKind(d.url, personal) && d.kind !== "" && d.kind !== row.kind) {
    body.kind = d.kind;
  }
  if (!personal) {
    const keyName = d.keyName === "" ? null : d.keyName;
    if (keyName !== (row.keyName ?? null)) body.keyName = keyName;
  }
  const ignore = d.ignore.trim() === "" ? "" : d.ignore;
  if (ignore !== row.ignore) body.ignore = ignore;
  return Object.keys(body).length === 0 ? null : body;
}

// the field a server refusal names, by its leading words
export function repoFieldOf(message: string): string | undefined {
  const m = message.toLowerCase();
  if (m.startsWith("url") || m.includes("must be on github.com")) return "url";
  if (m.startsWith("name") || m.startsWith("a repository named")) {
    return "name";
  }
  if (m.startsWith("kind")) return "kind";
  if (m.startsWith("ref")) return "ref";
  if (m.startsWith("keyname") || m.includes("takes no key")) return "keyName";
  if (m.startsWith("ignore")) return "ignore";
  return undefined;
}

export const shortCommit = (commit: string) => commit.slice(0, 7);

// the URL as text, without the scheme every one carries
export const urlText = (url: string) => url.replace(/^https:\/\//, "");

export type StateWords = { text: string; bad: boolean };

export function stateWords(repo: RepoView): StateWords {
  switch (repo.state) {
    case "pending":
      return { text: "Waiting to fetch", bad: false };
    case "fetching":
      return { text: "Fetching", bad: false };
    case "failed": {
      // past a cap the fetch stores what it had seen when it stopped
      const counts =
        repo.error === "over the size cap" && repo.files !== null
          ? [pluralCommas(repo.files, "file", "files")]
          : [];
      if (counts.length > 0 && repo.bytes !== null) {
        counts.push(sizeWords(repo.bytes));
      }
      const seen = counts.length > 0 ? ` at ${counts.join(", ")}` : "";
      return {
        text: repo.error === null ? "Failed" : `Failed: ${repo.error}${seen}`,
        bad: true,
      };
    }
    case "ready": {
      const parts = [
        repo.commit === null ? "Ready" : `Ready at ${shortCommit(repo.commit)}`,
      ];
      if (repo.files !== null) {
        parts.push(pluralCommas(repo.files, "file", "files"));
      }
      if (repo.ignored !== null && repo.ignored > 0) {
        parts.push(`${commas(repo.ignored)} ignored`);
      }
      return { text: parts.join(", "), bad: false };
    }
  }
}

export const atCap = (list: readonly RepoView[]) =>
  list.length >= MAX_REPOS_PER_PROJECT;

// None, then the key files; a saved one gone or unusable stays, marked
export function repoKeyOptions(
  keys: readonly CredentialKey[],
  current: string,
): Option[] {
  return [{ value: "", label: "None" }, ...keyOptions(keys, current)];
}

// four lines, growing with what is typed; the hint names the defaults
export function ignoreRows(typed: string): number {
  return Math.max(4, typed.split("\n").length + 1);
}

export const DELETE_ASK = "Delete this repository?";
