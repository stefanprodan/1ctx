// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Request and response bodies of the repository routes. A team
// project's are written by admins under /api/projects/:id/repos, the
// caller's personal project's by its owner under
// /api/profile/project/repos; anyone who sees the project lists them.

import type { RepoError, RepoKind, RepoState } from "../contracts/repo.ts";

export type RepoView = {
  id: string;
  // the folder under /repos, unique in the project
  name: string;
  // normalized: https, no userinfo, query, fragment, .git or trailing /
  url: string;
  kind: RepoKind;
  // a branch, a tag or a commit; empty for the default branch
  ref: string;
  // the http- key file a private repository is fetched with, null for a
  // public one; only an admin's answer carries it
  keyName?: string | null;
  // .gitignore rules; empty for the default list
  ignore: string;
  state: RepoState;
  error: RepoError | null;
  // what the last fetch got, null before one
  commit: string | null;
  fetchedAt: number | null;
  // the kept tree, and the files the rules left out
  files: number | null;
  bytes: number | null;
  ignored: number | null;
  createdAt: number;
  updatedAt: number;
};

// GET /api/projects/:id/repos, in name order
export type ReposResponse = { repos: RepoView[] };

// a create, a change and a refresh answer the row
export type RepoResponse = { repo: RepoView };

// POST: the name defaults to the URL's last segment; the kind follows
// from github.com and gitlab.com and is required for any other host
export type CreateRepoRequest = {
  url: string;
  name?: string;
  kind?: RepoKind;
  ref?: string;
  keyName?: string | null;
  ignore?: string;
};

// PATCH: any field; a change to the url, kind, ref, key or ignore rules
// sets the row pending
export type PatchRepoRequest = Partial<CreateRepoRequest>;
