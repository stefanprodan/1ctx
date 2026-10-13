// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A create, a refresh or a change to what is fetched fetches at once, so
// the admin sees the outcome on the row.

import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { threadJobs } from "../../../src/server/repos/index.ts";
import type { RepoResponse } from "../../../src/shared/api/repos.ts";
import { testApp } from "../../helpers/app.ts";
import { createTeam } from "../../helpers/projects.ts";
import {
  COMMIT,
  cacheDir,
  fakeHost,
  type HostAnswer,
  rowWrites,
  settledState,
  tarball,
  tarResponse,
} from "../../helpers/repos.ts";

const dir = cacheDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ARCHIVE = "https://codeload.github.com/acme/widgets/tar.gz";

test("a repository is fetched on create, on a change and on a refresh", async () => {
  const answers: Record<string, HostAnswer> = {
    [`${ARCHIVE}/HEAD`]: tarResponse(
      tarball([
        { name: "a.go", body: "x" },
        { name: "logo.png", body: "x" },
      ]),
    ),
    [`${ARCHIVE}/main`]: new Response("gone", { status: 404 }),
  };
  const host = fakeHost(answers);
  const app = await testApp({
    cacheDir: dir,
    repoJobs: threadJobs(host.fetch),
    fetcher: host.fetch,
  });
  const writes = rowWrites(app.repos.store);
  const settled = (id: string) => settledState(app.repos.store, writes, id);
  const client = app.client();
  await client.login("admin", "hunter2-test");
  const project = await createTeam(client, "platform");
  const created = await client.call(
    "POST",
    `/api/projects/${project.id}/repos`,
    {
      body: { url: "https://github.com/acme/widgets" },
    },
  );
  expect(created.status).toBe(201);
  const { repo } = (await created.json()) as RepoResponse;
  expect(repo.state).toBe("pending");
  expect(await settled(repo.id)).toBe("ready");
  expect(app.repos.byId(repo.id)).toMatchObject({
    commit: COMMIT,
    files: 1,
    ignored: 1,
  });

  // a new ignore text is a new folder
  await client.call("PATCH", `/api/projects/${project.id}/repos/${repo.id}`, {
    body: { ignore: "*.go\n" },
  });
  expect(await settled(repo.id)).toBe("ready");
  expect(app.repos.byId(repo.id)).toMatchObject({ files: 1, ignored: 1 });

  await client.call("PATCH", `/api/projects/${project.id}/repos/${repo.id}`, {
    body: { ref: "main" },
  });
  expect(await settled(repo.id)).toBe("failed");
  expect(app.repos.byId(repo.id)?.error).toBe("not found");

  // a refresh looks up afresh, within the minute too
  answers[`${ARCHIVE}/main`] = tarResponse(
    tarball([{ name: "b.go", body: "y" }]),
  );
  const refreshed = await client.call(
    "POST",
    `/api/projects/${project.id}/repos/${repo.id}/refresh`,
  );
  expect(refreshed.status).toBe(200);
  expect(await settled(repo.id)).toBe("ready");
  await app.shutdown();
});
