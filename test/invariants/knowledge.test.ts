// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { MAX_KNOWLEDGE_BODY } from "../../src/server/knowledge/limits.ts";
import { tokens } from "../../src/server/lib/tokens.ts";
import { DEFAULT_LIMITS } from "../../src/server/limits/index.ts";
import type {
  KnowledgeFileResponse,
  KnowledgeListResponse,
  KnowledgeVersionsResponse,
} from "../../src/shared/api/knowledge.ts";
import type { KnowledgeFile } from "../../src/shared/contracts/knowledge.ts";
import { hashPassword, type TestClient, testApp } from "../helpers/app.ts";

const base = (id: string) => `/api/projects/${id}/knowledge`;
const filePath = (project: string, file: string) =>
  `${base(project)}/files/${file}`;
const versionPath = (project: string, version: string) =>
  `${base(project)}/versions/${version}`;

async function setup() {
  const app = await testApp();
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  const owner = app.createUser({
    username: "writer",
    fullName: "Writer",
    email: "writer@example.com",
    role: "member",
    passwordHash: await hashPassword("password-test"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const client = app.client();
  expect((await client.login("writer", "password-test")).status).toBe(200);
  const projectId = app.projects.personal(owner.id)!.id;
  const close = async () => {
    await app.shutdown();
    app.db.close();
  };
  return { app, admin, owner, client, projectId, close };
}

async function add(
  client: TestClient,
  projectId: string,
  name = "docs/x.md",
  text = "one\n",
): Promise<KnowledgeFile> {
  const response = await client.call("POST", base(projectId), {
    body: { name, text },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as KnowledgeFileResponse).file;
}

async function list(
  client: TestClient,
  projectId: string,
): Promise<KnowledgeListResponse> {
  const response = await client.call("GET", base(projectId));
  expect(response.status).toBe(200);
  return response.json();
}

async function versions(client: TestClient, projectId: string, fileId: string) {
  const response = await client.call(
    "GET",
    `${filePath(projectId, fileId)}/versions`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as KnowledgeVersionsResponse).versions;
}

describe("knowledge routes", () => {
  test.each(["personal", "team"] as const)(
    "a %s member can add, read, restore and delete with attributed history",
    async (kind) => {
      const s = await setup();
      try {
        const projectId =
          kind === "personal"
            ? s.projectId
            : s.app.projects.createTeam({
                ownerId: s.owner.id,
                name: "team",
                description: "",
                now: s.app.now.value,
              }).id;
        if (kind === "team")
          s.app.projects.addMember(projectId, s.owner.id, s.app.now.value);
        const empty = await list(s.client, projectId);
        expect(empty).toEqual({
          files: [],
          deleted: [],
          totals: { files: 0, bytes: 0, tokens: 0 },
          limits: {
            fileBytes: 262144,
            files: 500,
            projectBytes: 16777216,
            historyDays: 90,
          },
        });
        const file = await add(s.client, projectId);
        expect(file).not.toHaveProperty("text");
        expect(file).not.toHaveProperty("digest");
        expect(file.author).toEqual({
          kind: "user",
          id: s.owner.id,
          name: "writer",
          sessionId: null,
          origin: null,
        });
        const path = filePath(projectId, file.id);
        expect(await (await s.client.call("GET", path)).json()).toEqual({
          file: {
            ...file,
            text: "one\n",
            language: "markdown",
            html: `<p class="md-p">one</p>`,
            code: null,
          },
        });
        const second = await s.client.call("PUT", path, {
          body: { text: "two\n", revision: 1 },
        });
        expect(second.status).toBe(200);
        expect((await second.json()).file.revision).toBe(2);
        const history = await versions(s.client, projectId, file.id);
        expect(history.map((row) => row.revision)).toEqual([2, 1]);
        expect(history[0]).not.toHaveProperty("text");
        const old = await s.client.call(
          "GET",
          versionPath(projectId, history[1]!.id),
        );
        expect(old.status).toBe(200);
        const text = (await old.json()).version.text;
        const restored = await s.client.call("PUT", path, {
          body: { text, revision: 2 },
        });
        expect(restored.status).toBe(200);
        expect((await restored.json()).file.revision).toBe(3);
        const project = await s.client.call(
          "GET",
          `/api/projects/${projectId}`,
        );
        expect((await project.json()).project.knowledge).toEqual({
          files: 1,
          tokens: tokens("one\n"),
        });
        const removed = await s.client.call("DELETE", path);
        expect(removed.status).toBe(204);
        expect(await removed.text()).toBe("");
        expect((await s.client.call("GET", path)).status).toBe(404);
        expect((await s.client.call("DELETE", path)).status).toBe(404);
        expect(
          (await s.client.call("PUT", path, { body: { text, revision: 3 } }))
            .status,
        ).toBe(404);
        const deleted = await list(s.client, projectId);
        expect(deleted.totals).toEqual({ files: 0, bytes: 0, tokens: 0 });
        expect(deleted.deleted[0]).toMatchObject({
          id: file.id,
          revision: 3,
          deletedBy: file.author,
          deletedAt: s.app.now.value,
        });
        const kept = await versions(s.client, projectId, file.id);
        expect(kept.map((row) => row.revision)).toEqual([4, 3, 2, 1]);
        expect(kept[0]).toMatchObject({ deleted: true, bytes: 0, lines: 0 });
        const fresh = await add(s.client, projectId, file.name, text);
        expect(fresh.id).not.toBe(file.id);
        expect(fresh.revision).toBe(1);
        expect(await versions(s.client, projectId, file.id)).toEqual(kept);
      } finally {
        await s.close();
      }
    },
  );

  test("personal owners and real team memberships define every route's audience", async () => {
    const s = await setup();
    try {
      const stranger = s.app.createUser({
        username: "other",
        fullName: "Other",
        email: "other@example.com",
        role: "member",
        passwordHash: await hashPassword("password-test"),
        mustChangePassword: false,
        now: s.app.now.value,
      });
      const other = s.app.client();
      await other.login("other", "password-test");
      const team = s.app.projects.createTeam({
        ownerId: s.owner.id,
        name: "team",
        description: "",
        now: s.app.now.value,
      });
      const otherTeam = s.app.projects.createTeam({
        ownerId: stranger.id,
        name: "other-team",
        description: "",
        now: s.app.now.value,
      });
      s.app.projects.addMember(team.id, s.owner.id, s.app.now.value);
      s.app.projects.addMember(otherTeam.id, stranger.id, s.app.now.value);
      for (const projectId of [s.projectId, team.id]) {
        const file = await add(s.client, projectId);
        const history = await versions(s.client, projectId, file.id);
        const requests = [
          { method: "GET", path: base(projectId) },
          {
            method: "POST",
            path: base(projectId),
            body: { name: "new", text: "" },
          },
          { method: "GET", path: filePath(projectId, file.id) },
          {
            method: "PUT",
            path: filePath(projectId, file.id),
            body: { text: "", revision: 1 },
          },
          { method: "DELETE", path: filePath(projectId, file.id) },
          { method: "GET", path: `${filePath(projectId, file.id)}/versions` },
          { method: "GET", path: versionPath(projectId, history[0]!.id) },
        ];
        for (const request of requests) {
          const callers =
            projectId === s.projectId ? [s.admin, other] : [other];
          for (const caller of callers) {
            expect(
              (
                await caller.call(request.method, request.path, {
                  body: request.body,
                })
              ).status,
            ).toBe(404);
          }
        }
        if (projectId === team.id) {
          expect(
            (await s.admin.call("GET", filePath(projectId, file.id))).status,
          ).toBe(200);
          expect(
            (
              await s.admin.call("PUT", filePath(projectId, file.id), {
                body: { text: "admin\n", revision: 1 },
              })
            ).status,
          ).toBe(200);
        }
      }
      const foreign = await add(other, otherTeam.id, "foreign");
      const history = await versions(other, otherTeam.id, foreign.id);
      for (const path of [
        filePath(team.id, foreign.id),
        `${filePath(team.id, foreign.id)}/versions`,
        versionPath(team.id, history[0]!.id),
      ])
        expect((await s.client.call("GET", path)).status).toBe(404);
      expect(
        (
          await s.client.call("PUT", filePath(team.id, foreign.id), {
            body: { text: "wrong project", revision: 1 },
          })
        ).status,
      ).toBe(404);
      expect(
        (await s.client.call("DELETE", filePath(team.id, foreign.id))).status,
      ).toBe(404);
    } finally {
      await s.close();
    }
  });

  test("taken and prefix names and stale revisions are explicit conflicts", async () => {
    const s = await setup();
    try {
      const file = await add(s.client, s.projectId);
      await add(s.client, s.projectId, "docs-", "");
      for (const name of ["docs/x.md", "docs", "docs/x.md/more"]) {
        const result = await s.client.call("POST", base(s.projectId), {
          body: { name, text: "new" },
        });
        expect(result.status).toBe(409);
        const words = (await result.json()).error;
        expect(words).toContain(
          name === file.name
            ? "a file named docs/x.md exists"
            : "conflicts with file",
        );
      }
      const stale = await s.client.call("PUT", filePath(s.projectId, file.id), {
        body: { text: "overwrite", revision: 5 },
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error: "docs/x.md is at revision 1",
      });
      expect(await versions(s.client, s.projectId, file.id)).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  test("bad bodies, ids and text get 400, oversized bodies 413 and cross-origin writes 403", async () => {
    const s = await setup();
    try {
      for (const body of [
        null,
        [],
        {},
        { name: "../escape", text: "" },
        { name: "x", text: "\u0000" },
        { name: "x", text: "\ud800" },
        { name: "x", text: "", unknown: 1 },
      ])
        expect(
          (await s.client.call("POST", base(s.projectId), { body })).status,
        ).toBe(400);
      expect(
        (await s.client.call("POST", base(s.projectId), { raw: "not JSON" }))
          .status,
      ).toBe(400);
      expect(
        (
          await s.client.call("POST", base(s.projectId), {
            body: { name: "x", text: "" },
            headers: { "content-length": String(MAX_KNOWLEDGE_BODY + 1) },
          })
        ).status,
      ).toBe(413);
      const file = await add(s.client, s.projectId);
      const path = filePath(s.projectId, file.id);
      for (const body of [
        { text: "", revision: 0 },
        { text: "" },
        { text: "", revision: 1, name: "renamed" },
      ]) {
        expect((await s.client.call("PUT", path, { body })).status).toBe(400);
      }
      for (const tail of [
        "/files/bad",
        "/files/bad/versions",
        "/versions/bad",
      ]) {
        expect(
          (await s.client.call("GET", `${base(s.projectId)}${tail}`)).status,
        ).toBe(400);
      }
      for (const method of ["POST", "PUT", "DELETE"]) {
        const response = await s.client.call(
          method,
          method === "POST" ? base(s.projectId) : path,
          {
            body:
              method === "POST"
                ? { name: "new", text: "" }
                : { text: "", revision: 1 },
            origin: "http://other.test",
          },
        );
        expect(response.status).toBe(403);
      }
      const big = "\t\n".repeat(40_000);
      const uploaded = await add(s.client, s.projectId, "large", big);
      expect(uploaded.bytes).toBe(80_000);
    } finally {
      await s.close();
    }
  });

  test("caps report numbers and lowered caps still allow smaller restores and deletes", async () => {
    const s = await setup();
    try {
      let values = {
        ...DEFAULT_LIMITS,
        knowledgeFileBytes: 4096,
        knowledgeFiles: 1,
      };
      expect(
        (await s.admin.call("PUT", "/api/limits", { body: { values } })).status,
      ).toBe(200);
      const file = await add(s.client, s.projectId, "x", "x\n".repeat(2048));
      let refused = await s.client.call("POST", base(s.projectId), {
        body: { name: "large", text: "x\n".repeat(2049) },
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toContain(
        "4098 bytes, the limit is 4096",
      );
      refused = await s.client.call("POST", base(s.projectId), {
        body: { name: "extra", text: "" },
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toContain("2 files, the limit is 1");
      values = {
        ...values,
        knowledgeFiles: 10,
        knowledgeFileBytes: 4 * 1024 * 1024,
        knowledgeProjectBytes: 2 * 1024 * 1024,
      };
      await s.admin.call("PUT", "/api/limits", { body: { values } });
      const large = await add(
        s.client,
        s.projectId,
        "large",
        "x\n".repeat(600_000),
      );
      refused = await s.client.call("POST", base(s.projectId), {
        body: { name: "over-base", text: "x\n".repeat(600_000) },
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toContain(
        "2404096 bytes, the limit is 2097152",
      );
      values = {
        ...values,
        knowledgeFileBytes: 4096,
        knowledgeFiles: 1,
        knowledgeProjectBytes: 1024 * 1024,
      };
      await s.admin.call("PUT", "/api/limits", { body: { values } });
      const next = await s.client.call("PUT", filePath(s.projectId, large.id), {
        body: { text: "x\n".repeat(599_999), revision: 1 },
      });
      expect(next.status).toBe(200);
      expect(
        (await s.client.call("DELETE", filePath(s.projectId, large.id))).status,
      ).toBe(204);
      expect(
        (await list(s.client, s.projectId)).files.map((row) => row.id),
      ).toEqual([file.id]);
      expect((await list(s.client, s.projectId)).limits).toMatchObject({
        fileBytes: 4096,
        files: 1,
        projectBytes: 1024 * 1024,
      });
    } finally {
      await s.close();
    }
  });

  test("history eviction is per file and project, and the hourly sweep keeps live history", async () => {
    const s = await setup();
    try {
      const values = {
        ...DEFAULT_LIMITS,
        knowledgeVersions: 2,
        knowledgeHistoryDays: 1,
        knowledgeFileBytes: 512 * 1024,
        knowledgeHistoryBytes: 1024 * 1024,
      };
      expect(
        (await s.admin.call("PUT", "/api/limits", { body: { values } })).status,
      ).toBe(200);
      const a = await add(s.client, s.projectId, "a", "one");
      const path = filePath(s.projectId, a.id);
      await s.client.call("PUT", path, { body: { text: "two", revision: 1 } });
      await s.client.call("PUT", path, {
        body: { text: "three", revision: 2 },
      });
      expect(
        (await versions(s.client, s.projectId, a.id)).map(
          (row) => row.revision,
        ),
      ).toEqual([3, 2]);
      await s.client.call("DELETE", path);
      expect(
        (await versions(s.client, s.projectId, a.id)).map(
          (row) => row.revision,
        ),
      ).toEqual([4, 3]);
      const live = await add(s.client, s.projectId, "live", "keep");
      s.app.now.value += 86_400_001;
      expect(s.app.sweep()).toBe(2);
      expect((await list(s.client, s.projectId)).deleted).toEqual([]);
      expect(await versions(s.client, s.projectId, live.id)).toHaveLength(1);
      const first = await add(
        s.client,
        s.projectId,
        "large-a",
        "x\n".repeat(192 * 1024),
      );
      const second = await add(
        s.client,
        s.projectId,
        "large-b",
        "x\n".repeat(192 * 1024),
      );
      await add(s.client, s.projectId, "large-c", "x\n".repeat(192 * 1024));
      expect(await versions(s.client, s.projectId, first.id)).toEqual([]);
      expect(await versions(s.client, s.projectId, second.id)).toHaveLength(1);
      expect(
        s.app.db
          .query("select sum(bytes) as bytes from knowledge_versions")
          .get(),
      ).toEqual({ bytes: 768 * 1024 });
    } finally {
      await s.close();
    }
  });

  test("emptying the bin drops deleted history and keeps live files", async () => {
    const s = await setup();
    try {
      const gone = await add(s.client, s.projectId, "gone", "one");
      await s.client.call("PUT", filePath(s.projectId, gone.id), {
        body: { text: "two", revision: 1 },
      });
      await s.client.call("DELETE", filePath(s.projectId, gone.id));
      const live = await add(s.client, s.projectId, "live", "keep");
      expect((await list(s.client, s.projectId)).deleted).toHaveLength(1);

      const emptied = await s.client.call(
        "DELETE",
        `${base(s.projectId)}/deleted`,
      );
      expect(emptied.status).toBe(200);
      expect(await emptied.json()).toEqual({ files: 3 });

      const after = await list(s.client, s.projectId);
      expect(after.deleted).toEqual([]);
      expect(after.files.map((file) => file.name)).toEqual(["live"]);
      expect(await versions(s.client, s.projectId, live.id)).toHaveLength(1);
      // the file and its history are both gone, so the route 404s
      expect(
        (
          await s.client.call(
            "GET",
            `${filePath(s.projectId, gone.id)}/versions`,
          )
        ).status,
      ).toBe(404);

      const again = await s.client.call(
        "DELETE",
        `${base(s.projectId)}/deleted`,
      );
      expect(await again.json()).toEqual({ files: 0 });
    } finally {
      await s.close();
    }
  });

  test("deleting a team project cascades live files and already deleted histories", async () => {
    const s = await setup();
    try {
      const response = await s.admin.call("POST", "/api/projects", {
        body: { name: "team" },
      });
      expect(response.status).toBe(201);
      const projectId = (await response.json()).project.id;
      const a = await add(s.admin, projectId, "a");
      await add(s.admin, projectId, "b");
      await s.admin.call("DELETE", filePath(projectId, a.id));
      expect(
        (await s.admin.call("DELETE", `/api/projects/${projectId}`)).status,
      ).toBe(200);
      expect(
        s.app.db
          .query("select * from knowledge_files where project_id = ?")
          .all(projectId),
      ).toEqual([]);
      expect(
        s.app.db
          .query("select * from knowledge_versions where project_id = ?")
          .all(projectId),
      ).toEqual([]);
      expect(s.app.db.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
