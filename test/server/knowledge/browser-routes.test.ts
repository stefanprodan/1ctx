// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type {
  KnowledgeFileResponse,
  KnowledgeSearchResponse,
} from "../../../src/shared/api/knowledge.ts";
import { hashPassword, testApp } from "../../helpers/app.ts";

const base = (id: string) => `/api/projects/${id}/knowledge`;

async function setup() {
  const app = await testApp();
  const owner = app.createUser({
    username: "writer",
    fullName: "Writer",
    email: "writer@example.com",
    role: "member",
    passwordHash: await hashPassword("password-test"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const other = app.createUser({
    username: "reader",
    fullName: "Reader",
    email: "reader@example.com",
    role: "member",
    passwordHash: await hashPassword("password-test"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const client = app.client();
  expect((await client.login("writer", "password-test")).status).toBe(200);
  const stranger = app.client();
  expect((await stranger.login("reader", "password-test")).status).toBe(200);
  const projectId = app.projects.personal(owner.id)!.id;
  const foreignId = app.projects.personal(other.id)!.id;
  const close = async () => {
    await app.shutdown();
    app.db.close();
  };
  return { app, client, stranger, projectId, foreignId, close };
}

describe("knowledge browser routes", () => {
  test("searches names and text", async () => {
    const s = await setup();
    try {
      for (const [name, text] of [
        ["plans/topic.md", "none\n"],
        ["notes/a.md", "one\nThe Topic here\n"],
      ]) {
        const created = await s.client.call("POST", base(s.projectId), {
          body: { name, text },
        });
        expect(created.status).toBe(201);
      }
      const response = await s.client.call(
        "GET",
        `${base(s.projectId)}/search?q=topic`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as KnowledgeSearchResponse;
      expect(body.names.map((file) => file.name)).toEqual(["plans/topic.md"]);
      expect(body.namesTotal).toBe(1);
      expect(body.files).toEqual([
        {
          file: expect.objectContaining({ name: "notes/a.md" }),
          count: 1,
          lines: [
            { line: 2, text: "The Topic here", cutStart: false, cutEnd: false },
          ],
        },
      ]);
      expect(body.next).toBeNull();
    } finally {
      await s.close();
    }
  });

  test.each(["", "?q=a", "?q=ab&q=cd", "?q=ab&after=..", "?q=ab&x=1"])(
    "a search of %j is a 400",
    async (query) => {
      const s = await setup();
      try {
        const response = await s.client.call(
          "GET",
          `${base(s.projectId)}/search${query}`,
        );
        expect(response.status).toBe(400);
      } finally {
        await s.close();
      }
    },
  );

  test("another's project is a 404 to search and rename", async () => {
    const s = await setup();
    try {
      const created = await s.client.call("POST", base(s.projectId), {
        body: { name: "a.md", text: "one\n" },
      });
      const file = ((await created.json()) as KnowledgeFileResponse).file;
      expect(
        (await s.stranger.call("GET", `${base(s.projectId)}/search?q=one`))
          .status,
      ).toBe(404);
      expect(
        (
          await s.stranger.call(
            "PATCH",
            `${base(s.projectId)}/files/${file.id}`,
            {
              body: { name: "b.md", revision: 1 },
            },
          )
        ).status,
      ).toBe(404);
      // the file's own id under the caller's project is not found either
      expect(
        (
          await s.stranger.call(
            "PATCH",
            `${base(s.foreignId)}/files/${file.id}`,
            { body: { name: "b.md", revision: 1 } },
          )
        ).status,
      ).toBe(404);
    } finally {
      await s.close();
    }
  });

  test("renames with a revision and answers conflicts in words", async () => {
    const s = await setup();
    try {
      const add = async (name: string) => {
        const response = await s.client.call("POST", base(s.projectId), {
          body: { name, text: "one\n" },
        });
        return ((await response.json()) as KnowledgeFileResponse).file;
      };
      const file = await add("a.md");
      await add("b.md");
      const path = `${base(s.projectId)}/files/${file.id}`;
      const taken = await s.client.call("PATCH", path, {
        body: { name: "b.md", revision: 1 },
      });
      expect(taken.status).toBe(409);
      expect((await taken.json()).error).toBe("a file named b.md exists");
      const stale = await s.client.call("PATCH", path, {
        body: { name: "c.md", revision: 3 },
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error).toBe("a.md is at revision 1");
      const bad = await s.client.call("PATCH", path, {
        body: { name: "c.md", revision: 1, text: "x" },
      });
      expect(bad.status).toBe(400);
      const renamed = await s.client.call("PATCH", path, {
        body: { name: "docs/c.md", revision: 1 },
      });
      expect(renamed.status).toBe(200);
      const moved = ((await renamed.json()) as KnowledgeFileResponse).file;
      expect(moved).toMatchObject({
        id: file.id,
        name: "docs/c.md",
        revision: 2,
      });
      const detail = await (await s.client.call("GET", path)).json();
      expect(detail.file).toMatchObject({ name: "docs/c.md", text: "one\n" });
    } finally {
      await s.close();
    }
  });
});
