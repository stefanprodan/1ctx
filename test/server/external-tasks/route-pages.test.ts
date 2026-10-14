// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import type {
  ClosedTasksResponse,
  WaitingTasksResponse,
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
          await f.member.client.call(
            "POST",
            `/api/external-tasks/${id}/cancel`,
            {
              body: { state: "todo" },
            },
          )
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

test("closed pages search the title, the labels and the creator, and filter done or canceled", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const done = async (fields: object, client = f.creator.client) => {
    const id = (await f.create(fields, client)).task.task.id;
    const claim = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(key, id, claim.claimId, "result", "Done.", []);
    f.app.now.value++;
    return id;
  };
  const cancelled = async (fields: object, client = f.creator.client) => {
    const id = (await f.create(fields, client)).task.task.id;
    const response = await f.member.client.call(
      "POST",
      `/api/external-tasks/${id}/cancel`,
      { body: { state: "todo" } },
    );
    expect(response.status).toBe(200);
    f.app.now.value++;
    return id;
  };
  const percent = await done({
    title: "Ship 100% of the API",
    labels: ["plan"],
  });
  const sweep = await cancelled({ title: "Sweep" }, f.member.client);
  const under = await done(
    { title: "Other web_ui", labels: ["fix"] },
    f.member.client,
  );
  const plain = await cancelled({ title: "Webxui 100 points" });
  await f.create({ title: "Still open API", labels: ["fix"] });
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
  expect(await ids("&state=canceled")).toEqual([plain, sweep]);
  expect(await ids("&q=api")).toEqual([percent]);
  expect(await ids("&q=%20%20API%20")).toEqual([percent]);
  expect(await ids("&q=member")).toEqual([under, sweep]);
  expect(await ids("&q=member&state=canceled")).toEqual([sweep]);
  // a label matches by its name now
  expect(await ids("&q=fix")).toEqual([under]);
  expect(await ids("&q=PLA")).toEqual([percent]);
  expect(await ids("&q=build&state=canceled")).toEqual([plain, sweep]);
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

test("Home's waiting list is capped with a full count and holds only tasks awaiting input", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const ids: string[] = [];
  const personal = f.app.projects.personal(f.member.user.id)!.id;
  const own = await f.file("own.md", personal, f.member.client);
  for (let i = 0; i < ATTENTION_ROWS + 3; i++) {
    const made =
      i === 0
        ? await f.create({ fileIds: [own] }, f.member.client, personal)
        : await f.create();
    const id = made.task.task.id;
    const claim = f.app.externalTasks.claim(key, id);
    f.app.now.value++;
    f.app.externalTasks.report(key, id, claim.claimId, "question", "Q?", []);
    ids.push(id);
  }
  // a result, a claim and a todo task never reach Home
  for (const end of ["result", "progress", null] as const) {
    const id = (await f.create()).task.task.id;
    if (end === null) continue;
    const claim = f.app.externalTasks.claim(key, id);
    f.app.externalTasks.report(key, id, claim.claimId, end, "Here.", []);
  }
  const hiddenProject = f.app.projects.personal(f.creator.user.id)!.id;
  const hidden = (
    await f.create(
      { fileIds: [await f.file("own.md", hiddenProject)] },
      f.creator.client,
      hiddenProject,
    )
  ).task.task.id;
  const hiddenClaim = f.app.externalTasks.claim(key, hidden);
  f.app.externalTasks.report(
    key,
    hidden,
    hiddenClaim.claimId,
    "question",
    "Private?",
    [],
  );
  const waiting = async (
    client = f.member.client,
  ): Promise<WaitingTasksResponse> => {
    const response = await client.call("GET", "/api/external-tasks?waiting=1");
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await waiting()).toMatchObject({ count: ids.length });
  expect((await waiting()).tasks.map((row) => row.id)).toEqual(
    ids.slice(0, ATTENTION_ROWS),
  );
  expect(await waiting(f.outsider.client)).toMatchObject({
    tasks: [],
    count: 0,
  });
  // a read leaves it, an answer takes it off
  const id = ids[0]!;
  await f.show(id);
  expect((await waiting()).count).toBe(ids.length);
  const answered = await f.member.client.call(
    "POST",
    `/api/external-tasks/${id}/answer`,
    { body: { state: "awaiting_input", text: "Go." } },
  );
  expect(answered.status).toBe(200);
  expect((await waiting()).count).toBe(ids.length - 1);
  expect((await waiting()).tasks[0]!.id).toBe(ids[1]!);
  // the old query and the old move are gone
  expect(
    (await f.member.client.call("GET", "/api/external-tasks?attention=1"))
      .status,
  ).toBe(400);
  expect(
    (
      await f.member.client.call("POST", `/api/external-tasks/${id}/seen`, {
        body: { attentionAt: 1 },
      })
    ).status,
  ).toBe(404);
});

test("Home lists waiting tasks only from the projects a user belongs to, an admin too", async () => {
  await using f = await httpFixture();
  const key = await f.key();
  const id = (await f.create({ title: "Needs the team" })).task.task.id;
  const claim = f.app.externalTasks.claim(key, id);
  f.app.externalTasks.report(key, id, claim.claimId, "question", "Which?", []);
  const attention = async (client: typeof f.admin) => {
    const response = await client.call("GET", "/api/external-tasks?waiting=1");
    expect(response.status).toBe(200);
    return (await response.json()) as WaitingTasksResponse;
  };
  expect((await attention(f.member.client)).tasks.map((row) => row.id)).toEqual(
    [id],
  );
  // the admin sees the team's tab, but its questions are the team's
  const outside = await attention(f.admin);
  expect(outside).toMatchObject({ tasks: [], count: 0 });
  // the client drops frames from projects the read did not cover
  expect(outside.projectIds).not.toContain(f.projectId);
  const me = (await (await f.admin.call("GET", "/api/me")).json()).user;
  const personal = f.app.projects.personal(me.id)!.id;
  expect(outside.projectIds).toContain(personal);
  const tab = await f.admin.call("GET", f.base);
  expect(tab.status).toBe(200);
  expect((await tab.json()).tasks.map((row: { id: string }) => row.id)).toEqual(
    [id],
  );
  // once a member, the admin's Home has the team's questions
  const joined = await f.admin.call(
    "POST",
    `/api/projects/${f.projectId}/members`,
    { body: { userId: me.id } },
  );
  expect(joined.status).toBeLessThan(300);
  const inside = await attention(f.admin);
  expect(inside.tasks.map((row) => row.id)).toEqual([id]);
  expect(inside.projectIds).toContain(f.projectId);
});
