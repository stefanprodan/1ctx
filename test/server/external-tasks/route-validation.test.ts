// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  MAX_MOVE_BODY,
  MAX_TASK_BODY,
} from "../../../src/server/external-tasks/parse.ts";
import {
  MAX_BRIEF_BYTES,
  MAX_ENTRY_BYTES,
  MAX_PART,
  MAX_TASK_FILES,
} from "../../../src/server/external-tasks/rules.ts";
import { MAX_SEARCH, MAX_TITLE } from "../../../src/shared/words.ts";
import { httpFixture } from "./http-fixture.ts";

test("create and edit reject unknown fields, wrong types, oversized values and foreign files", async () => {
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
    { text: 1 },
    { text: "x".repeat(MAX_BRIEF_BYTES + 1) },
    { part: false },
    { part: "x".repeat(MAX_PART + 1) },
    { fileIds: null },
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
      body: { title: "Title", text: "", fileIds: [], ...fields },
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
  }
  for (const body of [
    null,
    [],
    "text",
    {},
    { title: "Title", text: "" },
    { title: "Title", fileIds: [] },
    { text: "", fileIds: [] },
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

test("moves validate their state, text and release claim before changing the task", async () => {
  await using f = await httpFixture();
  const id = (await f.create()).task.task.id;
  const claim = f.app.externalTasks.claim(await f.key(), id);
  const base = `/api/external-tasks/${id}`;
  for (const move of ["answer", "release", "drop", "reopen"] as const) {
    const valid = {
      state: "claimed",
      text: "A note.",
      ...(move === "release" ? { claimId: claim.claimId } : {}),
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
    if (move !== "drop") {
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
    if (move !== "release") {
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
        await f.member.client.call("POST", `${base}/release`, {
          body: { state: "claimed", text: "Release.", claimId },
        })
      ).status,
    ).toBe(400);
  }
  expect(
    (await f.member.client.call("POST", `${base}/seen`, { body: {} })).status,
  ).toBe(400);
  expect((await f.show(id)).entries).toEqual([]);
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
    [f.base, "?closed=1&state="],
    [f.base, "?closed=1&state=done&state=dropped"],
    [f.base, "?extra=1"],
    [detail, "?before="],
    [detail, "?before=bad"],
    [detail, "?before=abcdefghijkl&before=abcdefghijkl"],
    [detail, "?before=abcdefghijkl"],
    [detail, "?extra=1"],
    ["/api/external-tasks", ""],
    ["/api/external-tasks", "?attention=0"],
    ["/api/external-tasks", "?attention=1&attention=1"],
    ["/api/external-tasks", "?attention=1&extra=1"],
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

test("seen requires only a non-negative safe integer attention mark", async () => {
  await using f = await httpFixture();
  const id = (await f.create()).task.task.id;
  const path = `/api/external-tasks/${id}/seen`;
  for (const body of [
    undefined,
    null,
    [],
    "",
    {},
    { attentionAt: null },
    { attentionAt: "1" },
    { attentionAt: true },
    { attentionAt: -1 },
    { attentionAt: 0.5 },
    { attentionAt: Number.MAX_SAFE_INTEGER + 1 },
    { attentionAt: 1, state: "open" },
  ]) {
    expect((await f.member.client.call("POST", path, { body })).status).toBe(
      400,
    );
  }
  for (const attentionAt of [0, Number.MAX_SAFE_INTEGER]) {
    const response = await f.member.client.call("POST", path, {
      body: { attentionAt },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).task.task.revision).toBe(0);
  }
});

test("body caps reject declared and streamed excess while exact byte bounds accept JSON escapes", async () => {
  await using f = await httpFixture();
  const made = await f.create({
    title: "x".repeat(MAX_TITLE),
    part: "x".repeat(MAX_PART),
    text: "\u0001".repeat(MAX_BRIEF_BYTES),
  });
  expect(made.task.text).toHaveLength(MAX_BRIEF_BYTES);
  const id = made.task.task.id;
  f.app.externalTasks.claim(await f.key(), id);
  const answer = await f.member.client.call(
    "POST",
    `/api/external-tasks/${id}/answer`,
    {
      body: { state: "claimed", text: "\u0001".repeat(MAX_ENTRY_BYTES) },
    },
  );
  expect(answer.status).toBe(200);
  for (const [method, path, cap] of [
    ["POST", f.base, MAX_TASK_BODY],
    ["PATCH", `/api/external-tasks/${id}`, MAX_TASK_BODY],
    ["POST", `/api/external-tasks/${id}/answer`, MAX_MOVE_BODY],
    ["POST", `/api/external-tasks/${id}/seen`, 1024],
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
