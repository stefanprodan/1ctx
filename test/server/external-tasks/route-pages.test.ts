// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type {
  AttentionTasksResponse,
  ClosedTasksResponse,
} from "../../../src/shared/api/external-tasks.ts";
import {
  ATTENTION_ROWS,
  CLOSED_PAGE,
  ENTRIES_PAGE,
} from "../../../src/shared/contracts/external-task.ts";
import { httpFixture } from "./http-fixture.ts";

test("closed pages sort latest first and continue without duplicating rows", async () => {
  await using f = await httpFixture();
  const ids: string[] = [];
  const key = await f.key();
  for (let i = 0; i < CLOSED_PAGE + 3; i++) {
    const id = (await f.create({ title: `Task ${i}` })).task.task.id;
    ids.unshift(id);
    f.app.now.value++;
    if (i % 2 === 0) {
      const claim = f.app.externalTasks.claim(key, id);
      f.app.externalTasks.report(
        key,
        claim.task.task.id,
        claim.claimId,
        "result",
        "Done.",
        [],
      );
    } else {
      expect(
        (
          await f.member.client.call("POST", `/api/external-tasks/${id}/drop`, {
            body: { state: "open" },
          })
        ).status,
      ).toBe(200);
    }
  }
  const first = await f.member.client.call("GET", `${f.base}?closed=1`);
  expect(first.status).toBe(200);
  const page: ClosedTasksResponse = await first.json();
  expect(Object.keys(page).sort()).toEqual(["next", "tasks"]);
  expect(page.tasks.map((row) => row.id)).toEqual(ids.slice(0, CLOSED_PAGE));
  expect(page.next).not.toBeNull();
  const second = await f.member.client.call(
    "GET",
    `${f.base}?closed=1&after=${page.next}`,
  );
  expect(second.status).toBe(200);
  const rest: ClosedTasksResponse = await second.json();
  expect(rest.tasks.map((row) => row.id)).toEqual(ids.slice(CLOSED_PAGE));
  expect(rest.next).toBeNull();
  const open = await f.member.client.call("GET", f.base);
  expect(await open.json()).toEqual({
    tasks: [],
    closed: ids.length,
    idleHours: 24,
  });
});

test("closed pages search the title, the scope and the creator, and filter done or dropped", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const done = async (fields: object, client = f.creator.client) => {
    const id = (await f.create(fields, client)).task.task.id;
    const claim = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(key, id, claim.claimId, "result", "Done.", []);
    f.app.now.value++;
    return id;
  };
  const dropped = async (fields: object, client = f.creator.client) => {
    const id = (await f.create(fields, client)).task.task.id;
    const response = await f.member.client.call(
      "POST",
      `/api/external-tasks/${id}/drop`,
      { body: { state: "open" } },
    );
    expect(response.status).toBe(200);
    f.app.now.value++;
    return id;
  };
  const percent = await done({ title: "Ship 100% of the API", scope: "api" });
  const sweep = await dropped({ title: "Sweep" }, f.member.client);
  const under = await done(
    { title: "Other", scope: "web_ui" },
    f.member.client,
  );
  const plain = await dropped({ title: "Webxui 100 points" });
  await f.create({ title: "Still open API" });
  const ids = async (query: string) => {
    const response = await f.member.client.call(
      "GET",
      `${f.base}?closed=1${query}`,
    );
    expect(response.status).toBe(200);
    const page: ClosedTasksResponse = await response.json();
    return page.tasks.map((row) => row.id);
  };
  expect(await ids("")).toEqual([plain, under, sweep, percent]);
  expect(await ids("&state=done")).toEqual([under, percent]);
  expect(await ids("&state=dropped")).toEqual([plain, sweep]);
  expect(await ids("&q=api")).toEqual([percent]);
  expect(await ids("&q=%20%20API%20")).toEqual([percent]);
  expect(await ids("&q=member")).toEqual([under, sweep]);
  expect(await ids("&q=member&state=dropped")).toEqual([sweep]);
  // the wildcards match as written
  expect(await ids("&q=100%25")).toEqual([percent]);
  expect(await ids("&q=b_u")).toEqual([under]);
  expect(await ids("&q=nothing")).toEqual([]);
  expect(await ids("&q=")).toEqual([plain, under, sweep, percent]);
});

test("detail entries continue by entry id through timestamp ties and new reports", async () => {
  await using f = await httpFixture();
  const id = (await f.create()).task.task.id;
  const key = await f.key();
  const claim = f.app.externalTasks.claim(key, id);
  // the claim's own entry is the oldest, paged like any other
  const claimed = (await f.show(id)).entries;
  expect(claimed.map((entry) => entry.kind)).toEqual(["claim"]);
  const ids = [claimed[0]!.id];
  for (let i = 0; i < ENTRIES_PAGE + 3; i++) {
    ids.unshift(
      f.app.externalTasks.report(
        key,
        claim.task.task.id,
        claim.claimId,
        "progress",
        `Step ${i}`,
        [],
      ).entry.id,
    );
  }
  const first = await f.show(id);
  expect(first.entries.map((entry) => entry.id)).toEqual(
    ids.slice(0, ENTRIES_PAGE),
  );
  expect(first.next).not.toBeNull();
  f.app.externalTasks.report(
    key,
    claim.task.task.id,
    claim.claimId,
    "progress",
    "Another step",
    [],
  );
  const rest = await f.show(id, f.member.client, `?before=${first.next}`);
  expect(rest.entries.map((entry) => entry.id)).toEqual(
    ids.slice(ENTRIES_PAGE),
  );
  expect(rest.next).toBeNull();
  const otherId = (await f.create()).task.task.id;
  expect(
    (
      await f.member.client.call(
        "GET",
        `/api/external-tasks/${otherId}?before=${first.next}`,
      )
    ).status,
  ).toBe(400);
});

test("attention is capped with a visible count and seen clears its mark", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const ids: string[] = [];
  const personal = f.app.projects.personal(f.member.user.id)!.id;
  for (let i = 0; i < ATTENTION_ROWS + 3; i++) {
    const made =
      i === 0
        ? await f.create({}, f.member.client, personal)
        : await f.create();
    const id = made.task.task.id;
    const claim = f.app.externalTasks.claim(key, id);
    f.app.now.value++;
    f.app.externalTasks.report(
      key,
      claim.task.task.id,
      claim.claimId,
      "result",
      "Finished.",
      [],
    );
    ids.unshift(id);
  }
  const hiddenProject = f.app.projects.personal(f.creator.user.id)!.id;
  const hidden = (await f.create({}, f.creator.client, hiddenProject)).task.task
    .id;
  const hiddenClaim = f.app.externalTasks.claim(key, hidden);
  f.app.externalTasks.report(
    key,
    hiddenClaim.task.task.id,
    hiddenClaim.claimId,
    "question",
    "Private?",
    [],
  );
  const attention = async (
    client = f.member.client,
  ): Promise<AttentionTasksResponse> => {
    const response = await client.call(
      "GET",
      "/api/external-tasks?attention=1",
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await attention()).toMatchObject({ count: ids.length });
  expect((await attention()).tasks.map((row) => row.id)).toEqual(
    ids.slice(0, ATTENTION_ROWS),
  );
  expect(await attention(f.outsider.client)).toEqual({ tasks: [], count: 0 });
  const id = ids[0]!;
  const before = f.app.externalTasks.store.byId(id)!;
  expect((await f.show(id)).task.task).toEqual(before);
  expect((await attention()).count).toBe(ids.length);
  const seen = await f.member.client.call(
    "POST",
    `/api/external-tasks/${id}/seen`,
    { body: { attentionAt: before.attentionAt } },
  );
  expect(seen.status).toBe(200);
  const result = await seen.json();
  expect(result.task.task).toMatchObject({
    attentionAt: null,
    revision: before.revision + 1,
    editRevision: before.editRevision,
    movedAt: before.movedAt,
  });
  expect((await attention()).count).toBe(ids.length - 1);
  expect((await attention()).tasks).toHaveLength(ATTENTION_ROWS);
  expect(
    (
      await f.member.client.call("POST", `/api/external-tasks/${id}/seen`, {
        body: { attentionAt: before.attentionAt },
      })
    ).status,
  ).toBe(200);
  expect((await f.show(id)).task.task.revision).toBe(before.revision + 1);
});

test.serial(
  "seen clears only the mark read before a later report",
  async () => {
    await using f = await httpFixture();
    const id = (await f.create()).task.task.id;
    const key = await f.key();
    const claim = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(
      key,
      id,
      claim.claimId,
      "question",
      "Which?",
      [],
    );
    const question = await f.show(id);
    f.app.now.value++;
    f.app.externalTasks.report(key, id, claim.claimId, "result", "Done.", []);
    const result = await f.show(id);
    const conn = await f.connect(f.member.client);
    const frames = () =>
      conn.frames.filter((frame) => frame.type === "externalTask");
    const seen = (attentionAt: number) =>
      f.member.client.call("POST", `/api/external-tasks/${id}/seen`, {
        body: { attentionAt },
      });
    expect(result.task.task.attentionAt).not.toBe(
      question.task.task.attentionAt,
    );
    const stale = await seen(question.task.task.attentionAt!);
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual(result);
    expect(await f.show(id)).toEqual(result);
    expect(frames()).toEqual([]);
    const current = await seen(result.task.task.attentionAt!);
    expect(current.status).toBe(200);
    const cleared = await current.json();
    expect(cleared.task.task).toEqual({
      ...result.task.task,
      attentionAt: null,
      revision: result.task.task.revision + 1,
    });
    expect(frames()).toHaveLength(1);
    const retry = await seen(result.task.task.attentionAt!);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(cleared);
    expect(frames()).toHaveLength(1);
  },
);
