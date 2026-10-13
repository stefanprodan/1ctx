// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { httpFixture } from "./http-fixture.ts";

test("an entry's knowledge path links in the task's project", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const id = (await f.create()).task.task.id;
  f.app.externalTasks.claim(key, id);
  const claimId = f.app.externalTasks.store.byId(id)!.claim!.id;
  f.app.externalTasks.report(
    key,
    id,
    claimId,
    "progress",
    "Wrote /knowledge/notes/out.md, see `/knowledge/x.md`.",
    [],
  );
  const shown = await f.show(id);
  const entry = shown.entries.find((row) => row.kind === "progress")!;
  expect(entry.html).toBe(
    `<p class="md-p">Wrote <a class="md-link md-path" href="/projects/${f.projectId}/knowledge/path?name=notes%2Fout.md">/knowledge/notes/out.md</a>, see <code class="md-code">/knowledge/x.md</code>.</p>`,
  );
});
