// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { MAX_MOVE_BODY } from "../../../src/server/external-tasks/parse.ts";
import {
  MAX_ENTRY_BYTES,
  MAX_TASK_FILES,
  MAX_TASK_LABELS,
} from "../../../src/server/external-tasks/rules.ts";
import { MAX_BODY } from "../../../src/server/lib/body.ts";
import { MAX_SEARCH, MAX_TITLE } from "../../../src/shared/words.ts";
import { httpFixture } from "./http-fixture.ts";

test("create and edit reject unknown fields, wrong types, oversized values, foreign files and labels, never naming one", async () => {
  await using f = await httpFixture();
  const id = (await f.create()).task.task.id;
  const personal = f.app.projects.personal(f.creator.user.id)!.id;
  const fileResponse = await f.creator.client.call(
    "POST",
    `/api/projects/${personal}/knowledge`,
    {
      body: { name: "other.md", text: "Other project." },
    },
  );
  expect(fileResponse.status).toBe(201);
  const foreign = (await fileResponse.json()).file.id;
  const badFields = [
    { title: null },
    { title: "" },
    { title: " \t" },
    { title: "two\nlines" },
    { title: "x".repeat(MAX_TITLE + 1) },
    { text: "The old brief." },
    { scope: "part B" },
    { labels: null },
    { labels: "build" },
    { labels: [1] },
    { labels: [] },
    { labels: ["build", "build"] },
    { labels: ["build", " BUILD"] },
    {
      labels: ["build", "fix", "plan", "research"].slice(
        0,
        MAX_TASK_LABELS + 1,
      ),
    },
    { labels: ["secret-name"] },
    { fileIds: null },
    { fileIds: [] },
    { fileIds: [1] },
    { fileIds: [""] },
    { fileIds: ["missing"] },
    { fileIds: [foreign] },
    { fileIds: [foreign, foreign] },
    {
      fileIds: Array.from({ length: MAX_TASK_FILES + 1 }, (_, i) => `file${i}`),
    },
    { state: "done" },
    { surprise: true },
  ];
  for (const fields of badFields) {
    const create = await f.member.client.call("POST", f.base, {
      body: {
        title: "Title",
        labels: ["build"],
        fileIds: [f.briefId],
        ...fields,
      },
    });
    expect(create.status, JSON.stringify(fields).slice(0, 100)).toBe(400);
    const edit = await f.member.client.call(
      "PATCH",
      `/api/external-tasks/${id}`,
      {
        body: { editRevision: 0, ...fields },
      },
    );
    expect(edit.status).toBe(400);
    // a refusal names the field, never a label's or a file's name
    for (const response of [create, edit]) {
      expect(JSON.stringify(await response.json())).not.toContain(
        "secret-name",
      );
    }
  }
  const unknown = await f.member.client.call("POST", f.base, {
    body: { title: "Title", labels: ["secret-name"], fileIds: [f.briefId] },
  });
  expect(await unknown.json()).toEqual({
    error: "labels must name this project's labels",
  });
  for (const body of [
    null,
    [],
    "text",
    {},
    { title: "Title", labels: ["build"] },
    { title: "Title", fileIds: [f.briefId] },
    { labels: ["build"], fileIds: [f.briefId] },
  ]) {
    expect((await f.member.client.call("POST", f.base, { body })).status).toBe(
      400,
    );
  }
  for (const body of [
    { title: "Title" },
    { editRevision: -1, title: "Title" },
    { editRevision: 0.5, title: "Title" },
    { editRevision: "0", title: "Title" },
    { editRevision: Number.MAX_SAFE_INTEGER + 1, title: "Title" },
    { editRevision: 0 },
  ]) {
    expect(
      (
        await f.member.client.call("PATCH", `/api/external-tasks/${id}`, {
          body,
        })
      ).status,
    ).toBe(400);
  }
  expect(
    (await f.member.client.call("POST", f.base, { raw: "{" })).status,
  ).toBe(400);
  const detail = await f.show(id);
  expect(detail.task.task.editRevision).toBe(0);
  expect(detail.task.task.title).toBe("Check the work");
});

test("moves validate their state, text and unclaim claim before changing the task", async () => {
  await using f = await httpFixture();
  const id = (await f.create()).task.task.id;
  const claim = f.app.externalTasks.claim(await f.key(), id);
  const base = `/api/external-tasks/${id}`;
  for (const move of ["answer", "unclaim", "cancel", "reopen"] as const) {
    const valid = {
      state: "in_progress",
      text: "A note.",
      ...(move === "unclaim" ? { claimId: claim.claimId } : {}),
    };
    for (const extra of [
      { state: "unknown" },
      { state: null },
      { state: 1 },
      { text: null },
      { text: 1 },
      { text: "x".repeat(MAX_ENTRY_BYTES + 1) },
      { extra: true },
      { links: [] },
    ]) {
      expect(
        (
          await f.member.client.call("POST", `${base}/${move}`, {
            body: { ...valid, ...extra },
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await f.member.client.call("POST", `${base}/${move}`, {
          body: { text: "No state." },
        })
      ).status,
    ).toBe(400);
    if (move !== "cancel") {
      for (const text of [undefined, "", " \n\t "]) {
        expect(
          (
            await f.member.client.call("POST", `${base}/${move}`, {
              body: { ...valid, text },
            })
          ).status,
        ).toBe(400);
      }
    }
    if (move !== "unclaim") {
      expect(
        (
          await f.member.client.call("POST", `${base}/${move}`, {
            body: { ...valid, claimId: claim.claimId },
          })
        ).status,
      ).toBe(400);
    }
  }
  for (const claimId of [undefined, null, "", 1]) {
    expect(
      (
        await f.member.client.call("POST", `${base}/unclaim`, {
          body: { state: "in_progress", text: "Unclaim.", claimId },
        })
      ).status,
    ).toBe(400);
  }
  expect((await f.show(id)).entries.map((entry) => entry.kind)).toEqual([
    "claim",
  ]);
});

test("queries reject unknown, repeated and malformed parameters", async () => {
  await using f = await httpFixture();
  const id = (await f.create()).task.task.id;
  const detail = `/api/external-tasks/${id}`;
  for (const [path, query] of [
    [f.base, "?closed=0"],
    [f.base, "?closed=1&closed=1"],
    [f.base, "?after=1.abcdefghijkl"],
    [f.base, "?closed=1&after=bad"],
    [f.base, "?closed=1&after="],
    [f.base, "?q=api"],
    [f.base, "?state=done"],
    [f.base, "?closed=1&q=a&q=b"],
    [f.base, `?closed=1&q=${"a".repeat(MAX_SEARCH + 1)}`],
    [f.base, "?closed=1&state=open"],
    [f.base, "?closed=1&state=cancelled"],
    [f.base, "?closed=1&state=todo"],
    [f.base, "?closed=1&state="],
    [f.base, "?closed=1&state=done&state=canceled"],
    [f.base, "?extra=1"],
    [detail, "?before="],
    [detail, "?before=bad"],
    [detail, "?before=abcdefghijkl&before=abcdefghijkl"],
    [detail, "?before=abcdefghijkl"],
    [detail, "?extra=1"],
    ["/api/external-tasks", ""],
    ["/api/external-tasks", "?attention=1"],
    ["/api/external-tasks", "?waiting=0"],
    ["/api/external-tasks", "?waiting=1&waiting=1"],
    ["/api/external-tasks", "?waiting=1&extra=1"],
  ]) {
    expect((await f.member.client.call("GET", `${path}${query}`)).status).toBe(
      400,
    );
  }
  expect(
    (
      await f.member.client.call("PATCH", `${detail}?extra=1`, {
        body: { editRevision: 0, title: "Other" },
      })
    ).status,
  ).toBe(400);
});

test("body caps reject declared and streamed excess while exact byte bounds accept JSON escapes", async () => {
  await using f = await httpFixture();
  const made = await f.create({ title: "x".repeat(MAX_TITLE) });
  const id = made.task.task.id;
  f.app.externalTasks.claim(await f.key(), id);
  const answer = await f.member.client.call(
    "POST",
    `/api/external-tasks/${id}/answer`,
    {
      body: { state: "in_progress", text: "\u0001".repeat(MAX_ENTRY_BYTES) },
    },
  );
  expect(answer.status).toBe(200);
  for (const [method, path, cap] of [
    ["POST", f.base, MAX_BODY],
    ["PATCH", `/api/external-tasks/${id}`, MAX_BODY],
    ["POST", `/api/external-tasks/${id}/answer`, MAX_MOVE_BODY],
  ] as const) {
    expect(
      (await f.member.client.call(method, path, { raw: "x".repeat(cap + 1) }))
        .status,
    ).toBe(413);
    expect(
      (
        await f.member.client.call(method, path, {
          raw: "{}",
          headers: { "content-length": String(cap + 1) },
        })
      ).status,
    ).toBe(413);
  }
});
