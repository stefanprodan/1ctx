// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  logCacheSwept,
  logFetched,
  logFetchFailed,
} from "../../../src/server/repos/index.ts";
import { collectLogs } from "../../helpers/app.ts";

test("a fetch logs ids, the host, counts and the closed word, never a URL", () => {
  const { events, logFactory } = collectLogs();
  const log = logFactory("repos");
  logFetched(log, {
    repoId: "r1",
    host: "github.com",
    commit: "a".repeat(40),
    files: 364,
    bytes: 2048,
    duration: 812.6,
  });
  logFetchFailed(log, {
    repoId: "r1",
    host: "github.com",
    error: "no access",
    status: 403,
  });
  logFetchFailed(log, {
    repoId: "r1",
    host: "github.com",
    error: "host unreachable",
    status: null,
  });
  logCacheSwept(log, { trees: 2, bytes: 4096, kept: 5, keptBytes: 8192 });
  expect(events.map(({ level, msg, fields }) => [level, msg, fields])).toEqual([
    [
      "info",
      "repo fetched",
      {
        repo_id: "r1",
        host: "github.com",
        commit: "a".repeat(40),
        files: 364,
        bytes: 2048,
        duration: 813,
      },
    ],
    [
      "warn",
      "repo fetch failed",
      { repo_id: "r1", host: "github.com", reason: "no access", status: 403 },
    ],
    [
      "warn",
      "repo fetch failed",
      { repo_id: "r1", host: "github.com", reason: "host unreachable" },
    ],
    [
      "info",
      "repo cache swept",
      { trees: 2, bytes: 4096, kept: 5, kept_bytes: 8192 },
    ],
  ]);
});
