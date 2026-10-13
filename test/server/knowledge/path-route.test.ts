// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The file a /knowledge/ path names, for a link in a reply.

import { describe, expect, test } from "bun:test";
import type {
  KnowledgeFileResponse,
  KnowledgePathResponse,
} from "../../../src/shared/api/knowledge.ts";
import { hashPassword, testApp } from "../../helpers/app.ts";

const base = (id: string) => `/api/projects/${id}/knowledge`;
const pathOf = (id: string, name: string) =>
  `${base(id)}/path?name=${encodeURIComponent(name)}`;

async function setup() {
  const app = await testApp();
  const users = [];
  for (const username of ["writer", "reader"]) {
    users.push(
      app.createUser({
        username,
        fullName: username,
        email: `${username}@example.com`,
        role: "member",
        passwordHash: await hashPassword("password-test"),
        mustChangePassword: false,
        now: app.now.value,
      }),
    );
  }
  const client = app.client();
  expect((await client.login("writer", "password-test")).status).toBe(200);
  const stranger = app.client();
  expect((await stranger.login("reader", "password-test")).status).toBe(200);
  const projectId = app.projects.personal(users[0]!.id)!.id;
  const foreignId = app.projects.personal(users[1]!.id)!.id;
  const create = async (
    who: typeof client,
    project: string,
    name: string,
  ): Promise<KnowledgeFileResponse["file"]> => {
    const created = await who.call("POST", base(project), {
      body: { name, text: "text\n" },
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as KnowledgeFileResponse).file;
  };
  const close = async () => {
    await app.shutdown();
    app.db.close();
  };
  return { client, stranger, projectId, foreignId, create, close };
}

describe("knowledge path route", () => {
  test("names the live file of that name", async () => {
    const s = await setup();
    try {
      const file = await s.create(s.client, s.projectId, "plans/a_b.md");
      const response = await s.client.call(
        "GET",
        pathOf(s.projectId, "plans/a_b.md"),
      );
      expect(response.status).toBe(200);
      expect((await response.json()) as KnowledgePathResponse).toEqual({
        fileId: file.id,
      });
    } finally {
      await s.close();
    }
  });

  test("a miss, a deleted and a renamed file are not found", async () => {
    const s = await setup();
    try {
      const gone = await s.create(s.client, s.projectId, "gone.md");
      const moved = await s.create(s.client, s.projectId, "old.md");
      expect(
        (await s.client.call("DELETE", `${base(s.projectId)}/files/${gone.id}`))
          .status,
      ).toBe(204);
      expect(
        (
          await s.client.call(
            "PATCH",
            `${base(s.projectId)}/files/${moved.id}`,
            {
              body: { name: "new.md", revision: 1 },
            },
          )
        ).status,
      ).toBe(200);
      for (const name of ["none.md", "gone.md", "old.md"]) {
        expect(
          (await s.client.call("GET", pathOf(s.projectId, name))).status,
        ).toBe(404);
      }
      const renamed = await s.client.call("GET", pathOf(s.projectId, "new.md"));
      expect(((await renamed.json()) as KnowledgePathResponse).fileId).toBe(
        moved.id,
      );
    } finally {
      await s.close();
    }
  });

  test.each([
    "",
    "?name=",
    "?name=..%2Fx.md",
    "?name=a%252Fb",
    "?name=a.md&name=b.md",
    "?name=a.md&x=1",
  ])("a name of %j is a 400", async (query) => {
    const s = await setup();
    try {
      const response = await s.client.call(
        "GET",
        `${base(s.projectId)}/path${query}`,
      );
      expect(response.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  test("another's private project is not found", async () => {
    const s = await setup();
    try {
      await s.create(s.client, s.projectId, "a.md");
      expect(
        (await s.stranger.call("GET", pathOf(s.projectId, "a.md"))).status,
      ).toBe(404);
    } finally {
      await s.close();
    }
  });

  test("the same name resolves in each project to its own file", async () => {
    const s = await setup();
    try {
      const mine = await s.create(s.client, s.projectId, "a.md");
      const theirs = await s.create(s.stranger, s.foreignId, "a.md");
      const read = async (who: typeof s.client, project: string) =>
        (
          (await (
            await who.call("GET", pathOf(project, "a.md"))
          ).json()) as KnowledgePathResponse
        ).fileId;
      expect(await read(s.client, s.projectId)).toBe(mine.id);
      expect(await read(s.stranger, s.foreignId)).toBe(theirs.id);
    } finally {
      await s.close();
    }
  });
});
