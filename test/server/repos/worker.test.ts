// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The fetch worker itself, on jobs that never reach a network.

import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { workerJobs } from "../../../src/server/repos/jobs.ts";
import type { FetchJob } from "../../../src/server/repos/unpack.ts";
import { cacheDir } from "../../helpers/repos.ts";

const WORKER = new URL(
  "../../../src/server/repos/fetch.worker.ts",
  import.meta.url,
);
const dir = cacheDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const job = (url: string): FetchJob => ({
  id: "w1",
  url,
  etag: null,
  header: null,
  expect: null,
  ignore: "",
  ignoreKey: "k",
  source: "s",
  cacheDir: dir,
  caps: { bytes: 1_000, files: 10, fileBytes: 1_000 },
  deadlineMs: 10_000,
  stallMs: 5_000,
  userAgent: "1ctx/test",
});

test("a job answers its closed word from the worker", async () => {
  const run = workerJobs(WORKER);
  const result = await run(
    job("http://git.test/acme/widgets.tar.gz"),
    () => true,
    new AbortController().signal,
  );
  expect(result).toEqual({
    ok: false,
    error: "host unreachable",
    status: null,
  });
});

test("an aborted job ends its worker at once", async () => {
  const run = workerJobs(WORKER);
  const stop = new AbortController();
  stop.abort();
  const result = await run(
    job("http://git.test/acme/widgets.tar.gz"),
    () => true,
    stop.signal,
  );
  expect(result).toMatchObject({ ok: false });
});
