// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  CreateRepoRequest,
  PatchRepoRequest,
  RepoView,
} from "../../../shared/api/repos.ts";
import type { CredentialSummary } from "../../../shared/contracts/credential.ts";
import {
  DEFAULT_REPO_IGNORE,
  MAX_REPOS_PER_PROJECT,
  PUBLIC_REPO_HOSTS,
  type RepoKind,
} from "../../../shared/contracts/repo.ts";
import { isName } from "../../../shared/words.ts";
import { commas, pluralCommas } from "../../lib/format.ts";
import type { Option } from "../../ui/Select.model.ts";

export type RepoDraft = {
  url: string;
  name: string;
  ref: string;
  // "" until picked, asked only for a host that does not fix it
  kind: RepoKind | "";
  // "" for none
  credentialId: string;
  ignore: string;
};

export const draftOf = (row: RepoView | null): RepoDraft => ({
  url: row?.url ?? "",
  name: row?.name ?? "",
  ref: row?.ref ?? "",
  kind: row?.kind ?? "",
  credentialId: row?.credentialId ?? "",
  ignore: row?.ignore ?? "",
});

export const KIND_OPTIONS: { value: RepoKind; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

export const URL_PLACEHOLDER = "https://github.com/owner/name";
export const IGNORE_PLACEHOLDER = DEFAULT_REPO_IGNORE.join("\n");
export const IGNORE_HINT = "In .gitignore format. Replaces the default list.";
export const PUBLIC_HINT =
  "Public repositories on github.com or gitlab.com, read-only in bash.";
export const CAP_LINE = `At most ${MAX_REPOS_PER_PROJECT} repositories.`;

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
  if (!personal && d.credentialId !== "") body.credentialId = d.credentialId;
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
    const credentialId = d.credentialId === "" ? null : d.credentialId;
    if (credentialId !== row.credentialId) body.credentialId = credentialId;
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
  if (
    m.startsWith("credential") ||
    m.startsWith("no such credential") ||
    m.includes("takes no credential")
  ) {
    return "credentialId";
  }
  if (m.startsWith("ignore")) return "ignore";
  return undefined;
}

export const shortCommit = (commit: string) => commit.slice(0, 7);

// the URL as text, without the scheme every one carries
export const urlText = (url: string) => url.replace(/^https:\/\//, "");

export type StateWords = { text: string; short: string; bad: boolean };

export function stateWords(repo: RepoView): StateWords {
  switch (repo.state) {
    case "pending":
      return { text: "Waiting to fetch", short: "Waiting", bad: false };
    case "fetching":
      return { text: "Fetching", short: "Fetching", bad: false };
    case "failed":
      return {
        text: repo.error === null ? "Failed" : `Failed: ${repo.error}`,
        short: "Failed",
        bad: true,
      };
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
      return { text: parts.join(", "), short: "Ready", bad: false };
    }
  }
}

export const atCap = (list: readonly RepoView[]) =>
  list.length >= MAX_REPOS_PER_PROJECT;

// None, then the credentials bound to the project; a named one no
// longer bound stays as an option, so the draft shows what is saved
export function credentialOptions(
  all: readonly CredentialSummary[] | null,
  projectId: string,
  current: string,
): Option[] {
  const bound = (all ?? []).filter((c) =>
    c.projects.some((p) => p.id === projectId),
  );
  const options: Option[] = [
    { value: "", label: "None" },
    ...bound.map((c) => ({ value: c.id, label: c.name, detail: c.prefix })),
  ];
  if (current !== "" && !bound.some((c) => c.id === current)) {
    const named = all?.find((c) => c.id === current);
    options.push({
      value: current,
      label: named?.name ?? "Deleted credential",
      detail: "Not bound to this project",
    });
  }
  return options;
}

// the textarea grows to show the default list, or what is typed
export function ignoreRows(typed: string): number {
  const lines = (text: string) => text.split("\n").length;
  return Math.max(lines(IGNORE_PLACEHOLDER), lines(typed)) + 1;
}

export const DELETE_ASK = "Delete this repository?";
