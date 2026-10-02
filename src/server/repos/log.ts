// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The repos area's log lines. A fetch never logs a URL, a ref name, a
// file name or a host's error text: they can say what a private
// repository is, and a redirect's location carries a token.

import type { RepoError } from "../../shared/contracts/repo.ts";
import type { Log } from "../lib/log.ts";

export function logFetched(
  log: Log,
  fields: {
    repoId: string;
    host: string;
    commit: string;
    files: number;
    bytes: number;
    duration: number;
  },
): void {
  log.info("repo fetched", {
    repo_id: fields.repoId,
    host: fields.host,
    commit: fields.commit,
    files: fields.files,
    bytes: fields.bytes,
    duration: Math.round(fields.duration),
  });
}

export function logFetchFailed(
  log: Log,
  fields: {
    repoId: string;
    host: string;
    error: RepoError;
    // the host's HTTP status, when one answered
    status: number | null;
  },
): void {
  log.warn("repo fetch failed", {
    repo_id: fields.repoId,
    host: fields.host,
    reason: fields.error,
    ...(fields.status === null ? {} : { status: fields.status }),
  });
}

export function logCacheSwept(
  log: Log,
  fields: { trees: number; bytes: number; kept: number; keptBytes: number },
): void {
  log.info("repo cache swept", {
    trees: fields.trees,
    bytes: fields.bytes,
    kept: fields.kept,
    kept_bytes: fields.keptBytes,
  });
}
