// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A repository as the wire knows it: a git host's tree a project mounts
// read-only for bash, by URL and ref, fetched by the server.

export const MAX_REPOS_PER_PROJECT = 10;
export const MAX_REPO_URL = 512;
export const MAX_REPO_REF = 200;
// the ignore rules, in .gitignore format
export const MAX_REPO_IGNORE_LINES = 200;
export const MAX_REPO_IGNORE_BYTES = 8 * 1024;

// the hosts a member may add to their personal project, each its kind
export const PUBLIC_REPO_HOSTS = {
  "github.com": "github",
  "gitlab.com": "gitlab",
} as const;

export const REPO_KINDS = ["github", "gitlab"] as const;
export type RepoKind = (typeof REPO_KINDS)[number];
export const isRepoKind = (value: unknown): value is RepoKind =>
  REPO_KINDS.includes(value as RepoKind);

export const REPO_STATES = ["pending", "fetching", "ready", "failed"] as const;
export type RepoState = (typeof REPO_STATES)[number];

// why a repository is not mounted: the closed set a row, a notice and a
// log line say, never a host's own words
export const REPO_ERRORS = [
  "not found",
  "no access",
  "host unreachable",
  "over the size cap",
  "cache full",
  "fetching",
] as const;
export type RepoError = (typeof REPO_ERRORS)[number];
