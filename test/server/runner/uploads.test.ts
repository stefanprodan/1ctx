// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { UPLOAD_LEASE_MS } from "../../../src/server/knowledge/limits.ts";
import { Registry } from "../../../src/server/runner/index.ts";
import { MAX_UPLOAD_RECORD_BYTES } from "../../../src/shared/uploads.ts";
import { chatApp, NO_TOOLS } from "../../helpers/chat.ts";
import {
  close,
  files,
  finish,
  send,
  stage,
  staged,
  stageFiles,
  start,
} from "./uploads-helpers.ts";

describe("uploads claimed by a send", () => {
  test("claims in request order and replaces bytes without rewriting earlier records", async () => {
    const chat = await chatApp();
    try {
      const first = await stage(chat, "Note.md", "first");
      const second = await stage(chat, "note.md", "second is longer");
      const started = await start(chat, [second.id, first.id]);
      const user = started.detail.messages.find((row) => row.kind === "user")!;
      expect(user.uploads).toEqual([
        {
          name: "note.md",
          archive: false,
          files: 1,
          bytes: 16,
          saved: ["note.md"],
        },
        {
          name: "Note.md",
          archive: false,
          files: 1,
          bytes: 5,
          saved: ["note.md"],
        },
      ]);
      expect(files(chat, started.sessionId)).toEqual([
        { name: "note.md", text: "first" },
      ]);
      expect(staged(chat)).toEqual([]);
      expect(
        chat.app.db.query("select * from upload_staged_files").all(),
      ).toEqual([]);
      await finish(chat, started.sessionId, started.script);

      const replacement = await stage(chat, "note.md", "new");
      const next = await send(chat, started.sessionId, [replacement.id]);
      expect(files(chat, started.sessionId)).toEqual([
        { name: "note.md", text: "new" },
      ]);
      expect(chat.app.knowledge.uploads.read(started.sessionId).revision).toBe(
        2,
      );
      expect(
        next.detail.messages.find((row) => row.id === user.id)?.uploads,
      ).toEqual(user.uploads);
      expect(
        next.detail.messages.filter((row) => row.kind === "user").at(-1)
          ?.uploads,
      ).toEqual([
        {
          name: "note.md",
          archive: false,
          files: 1,
          bytes: 3,
          saved: ["note.md"],
        },
      ]);
      expect(
        next.detail.messages
          .filter((row) => row.kind !== "user")
          .every((row) => row.uploads === null),
      ).toBeTrue();
      await finish(chat, started.sessionId, next.script);
    } finally {
      await close(chat);
    }
  });

  test.each(["file", "directory"])(
    "a %s clash refuses the whole send and retains its staged items",
    async (existing) => {
      const chat = await chatApp();
      try {
        const archive = () =>
          new Bun.Archive({ "readme.md": "nested" }).bytes();
        const old = await stage(
          chat,
          existing === "file" ? "docs" : "docs.tar",
          existing === "file" ? "root file" : await archive(),
        );
        const started = await start(chat, [old.id]);
        await finish(chat, started.sessionId, started.script);
        const item = await stage(
          chat,
          existing === "file" ? "docs.tar" : "docs",
          existing === "file" ? await archive() : "root file",
        );
        const harmless = await stage(chat, "other.md", "keep staged");
        const before = chat.app.knowledge.uploads.read(started.sessionId);
        const rows = chat.app.sessions.messages(started.sessionId);
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${started.sessionId}/messages`,
          { body: { message: "read", uploads: [harmless.id, item.id] } },
        );
        expect(response.status).toBe(409);
        expect((await response.json()).error).toContain(
          "clashes with an uploaded file",
        );
        expect(staged(chat)).toEqual([item, harmless]);
        expect(chat.app.knowledge.uploads.read(started.sessionId)).toEqual(
          before,
        );
        expect(chat.app.sessions.messages(started.sessionId)).toEqual(rows);
        expect(chat.scripted.scripts).toHaveLength(1);
        const retry = await send(chat, started.sessionId);
        await finish(chat, started.sessionId, retry.script);
      } finally {
        await close(chat);
      }
    },
  );

  test.each(["other user", "other project", "expired", "repeated"])(
    "refuses %s staged ids before creating a session",
    async (kind) => {
      const chat = await chatApp();
      try {
        const projectResponse = await chat.admin.call("POST", "/api/projects", {
          body: { name: "shared-files", description: "" },
        });
        expect(projectResponse.status).toBe(201);
        const { project } = await projectResponse.json();
        expect(
          (
            await chat.admin.call(
              "POST",
              `/api/projects/${project.id}/members`,
              { body: { userId: chat.memberId } },
            )
          ).status,
        ).toBe(201);
        const targetProject =
          kind === "other user" ? project.id : chat.projectId;
        const item = await stage(
          chat,
          "note.md",
          "private",
          kind === "other user" ? chat.admin : chat.member,
          kind === "other project" || kind === "other user"
            ? project.id
            : chat.projectId,
        );
        if (kind === "expired") chat.app.now.value += UPLOAD_LEASE_MS;
        const response = await chat.member.call("POST", "/api/sessions", {
          body: {
            projectId: targetProject,
            agentId: chat.agentId,
            message: "read",
            uploads: kind === "repeated" ? [item.id, item.id] : [item.id],
          },
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toEqual(expect.any(String));
        expect(chat.app.db.query("select * from sessions").all()).toEqual([]);
        expect(
          chat.app.db.query("select * from session_uploads").all(),
        ).toEqual([]);
        expect(chat.app.db.query("select id from upload_staged").all()).toEqual(
          [{ id: item.id }],
        );
        expect(chat.scripted.scripts).toHaveLength(0);
      } finally {
        await close(chat);
      }
    },
  );

  test.each([
    { name: "session lock", running: 4, perUser: 4, status: 409 },
    { name: "process cap", running: 1, perUser: 4, status: 429 },
    { name: "user cap", running: 4, perUser: 1, status: 429 },
  ])("$name preserves staging and the session tree", async (caps) => {
    const chat = await chatApp({
      registry: new Registry(caps),
    });
    try {
      const started = await start(chat);
      const item = await stage(chat, "readme.md");
      const response = await chat.member.call(
        "POST",
        caps.status === 409
          ? `/api/sessions/${started.sessionId}/messages`
          : "/api/sessions",
        {
          body: {
            ...(caps.status === 409
              ? {}
              : { projectId: chat.projectId, agentId: chat.agentId }),
            message: "read",
            uploads: [item.id],
          },
        },
      );
      expect(response.status).toBe(caps.status);
      expect(staged(chat)).toEqual([item]);
      expect(files(chat, started.sessionId)).toEqual([]);
      expect(chat.app.db.query("select id from sessions").all()).toEqual([
        { id: started.sessionId },
      ]);
      expect(chat.scripted.scripts).toHaveLength(1);
      await finish(chat, started.sessionId, started.script);
      const retry = await send(chat, started.sessionId, [item.id]);
      await finish(chat, started.sessionId, retry.script);
      expect(staged(chat)).toEqual([]);
    } finally {
      await close(chat);
    }
  });

  test("an agent without bash refuses uploads and leaves them staged", async () => {
    const chat = await chatApp({ model: NO_TOOLS });
    try {
      const item = await stage(chat, "readme.md");
      const response = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "read",
          uploads: [item.id],
        },
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        "this agent cannot read files",
      );
      expect(staged(chat)).toEqual([item]);
      expect(chat.app.db.query("select * from sessions").all()).toEqual([]);
      expect(chat.scripted.scripts).toHaveLength(0);
    } finally {
      await close(chat);
    }
  });

  test("eleven items are refused and ten are recorded with twenty names each", async () => {
    const chat = await chatApp();
    try {
      const items = Array.from({ length: 11 }, (_, item) =>
        stageFiles(
          chat,
          `bundle-${item}.tar`,
          Array.from({ length: 23 }, (_, file) => ({
            name: `bundle-${item}/${String(23 - file).padStart(2, "0")}.md`,
            text: "x",
          })),
        ),
      );
      const response = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "read",
          uploads: items.map((item) => item.id),
        },
      });
      expect(response.status).toBe(400);
      expect(staged(chat)).toEqual(items);
      expect(chat.app.db.query("select * from sessions").all()).toEqual([]);
      const started = await start(
        chat,
        items.slice(0, 10).map((item) => item.id),
      );
      const record = started.detail.messages[0]!.uploads!;
      expect(record).toHaveLength(10);
      for (const [i, item] of record.entries()) {
        expect(item).toMatchObject({
          name: items[i]!.name,
          files: 23,
          bytes: 23,
          saved: items[i]!.saved.slice(0, 20),
        });
      }
      expect(chat.app.knowledge.uploads.read(started.sessionId).files).toBe(
        230,
      );
      expect(staged(chat)).toEqual([items[10]!]);
      await finish(chat, started.sessionId, started.script);
    } finally {
      await close(chat);
    }
  });

  test("a real send bounds worst-case records at 32 KiB without cutting totals", async () => {
    const chat = await chatApp();
    try {
      const items = Array.from({ length: 10 }, (_, item) =>
        stageFiles(
          chat,
          `${item}-${'\u0001\\"'.repeat(100)}.tar`,
          Array.from({ length: 20 }, (_, file) => ({
            name: `item-${item}/${"a".repeat(70)}/${"b".repeat(70)}/${String(file).padStart(2, "0")}-${"c".repeat(44)}.md`,
            text: "x",
          })),
        ),
      );
      const uncut = items.map(({ name, archive, files, bytes, saved }) => ({
        name,
        archive,
        files,
        bytes,
        saved,
      }));
      expect(Buffer.byteLength(JSON.stringify(uncut))).toBeGreaterThan(
        MAX_UPLOAD_RECORD_BYTES,
      );
      const started = await start(
        chat,
        items.map((item) => item.id),
      );
      const record = started.detail.messages[0]!.uploads!;
      expect(record).toHaveLength(10);
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
        MAX_UPLOAD_RECORD_BYTES,
      );
      for (const [i, item] of record.entries()) {
        expect(item).toMatchObject({
          name: items[i]!.name,
          files: 20,
          bytes: 20,
        });
      }
      expect(record[0]!.saved).toEqual(items[0]!.saved);
      expect(record.at(-1)!.saved.length).toBeLessThan(20);
      expect(chat.app.knowledge.uploads.read(started.sessionId).files).toBe(
        200,
      );
      expect(
        chat.app.db
          .query<{ uploads: string }, [string]>(
            "select uploads from messages where id = ?",
          )
          .get(started.detail.messages[0]!.id)?.uploads,
      ).toBe(JSON.stringify(record));
      await finish(chat, started.sessionId, started.script);
    } finally {
      await close(chat);
    }
  });
});
