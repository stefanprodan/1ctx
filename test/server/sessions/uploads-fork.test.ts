// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ForkSessionResponse } from "../../../src/shared/api/sessions.ts";
import { uploadsBlock } from "../../../src/shared/uploads.ts";
import { type ChatApp, chatApp, setLimits } from "../../helpers/chat.ts";
import {
  close,
  files,
  finish,
  messages,
  send,
  stage,
  staged,
  stageFiles,
  start,
} from "../runner/uploads-helpers.ts";

async function fork(
  chat: ChatApp,
  sessionId: string,
  messageId: string,
): Promise<ForkSessionResponse> {
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/fork`,
    { body: { messageId, agentId: chat.agentId } },
  );
  expect(response.status).toBe(201);
  return response.json();
}

describe("forked chat uploads", () => {
  test("copies records through the answer and the current tree including files attached later", async () => {
    const chat = await chatApp();
    try {
      const first = await stage(chat, "first.md", "original bytes");
      const source = await start(chat, [first.id]);
      await finish(chat, source.sessionId, source.script, "first answer");
      const firstRows = chat.app.sessions.messages(source.sessionId);
      const answer = firstRows.find((row) => row.slot === "answer")!;
      const later = await stage(chat, "later.md", "attached after the point");
      const replacement = await stage(chat, "first.md", "current bytes");
      const second = await send(chat, source.sessionId, [
        later.id,
        replacement.id,
      ]);
      await finish(chat, source.sessionId, second.script);
      const before = chat.app.knowledge.uploads.read(source.sessionId);

      const copied = await fork(chat, source.sessionId, answer.id);
      expect(copied.draftUploads).toEqual([]);
      expect(copied.messages.map((row) => row.uploads)).toEqual(
        firstRows.map((row) => row.uploads),
      );
      expect(copied.messages.map((row) => row.content)).toEqual(
        firstRows.map((row) => row.content),
      );
      expect(files(chat, copied.session.id)).toEqual([
        { name: "first.md", text: "current bytes" },
        { name: "later.md", text: "attached after the point" },
      ]);
      expect(staged(chat)).toEqual([]);
      expect(chat.app.knowledge.uploads.read(source.sessionId)).toEqual(before);

      const next = await send(chat, copied.session.id, [], "continue the fork");
      expect(messages(next.script)[1]?.content).toBe(
        `${firstRows[0]!.content}\n\n${uploadsBlock(firstRows[0]!.uploads!)}`,
      );
      await finish(chat, copied.session.id, next.script);
      expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      await close(chat);
    }
  });

  test("a user-turn fork restages same-name archives as separate items in record and saved-file order", async () => {
    const chat = await chatApp();
    try {
      const first = await stage(
        chat,
        "docs.tar",
        await new Bun.Archive({
          "z.md": "last in file sort",
          "y.md": "next in file sort",
        }).bytes(),
      );
      const second = await stage(
        chat,
        "docs.tar",
        await new Bun.Archive({
          "docs/b.md": "second archive first",
          "docs/a.md": "second archive second",
        }).bytes(),
      );
      const middle = await stage(chat, "notes.md", "between the archives");
      expect(first.saved).toEqual(["docs/z.md", "docs/y.md"]);
      expect(second.saved).toEqual(["docs/b.md", "docs/a.md"]);
      expect([first.folder, middle.folder, second.folder]).toEqual([
        "docs",
        "",
        "",
      ]);
      const source = await start(chat, [first.id, middle.id, second.id]);
      await finish(chat, source.sessionId, source.script);
      const user = chat.app.sessions.messages(source.sessionId)[0]!;
      const later = await stage(chat, "later.md", "keep in the copied tree");
      const following = await send(chat, source.sessionId, [later.id]);
      await finish(chat, source.sessionId, following.script);
      const original = chat.app.knowledge.uploads.read(source.sessionId);

      const copied = await fork(chat, source.sessionId, user.id);
      expect(copied.messages).toEqual([]);
      expect(copied.draftUploads).toHaveLength(3);
      expect(new Set(copied.draftUploads).size).toBe(3);
      expect(
        copied.draftUploads.some((id) =>
          [first.id, middle.id, second.id].includes(id),
        ),
      ).toBeFalse();
      const byId = new Map(staged(chat).map((item) => [item.id, item]));
      const restaged = copied.draftUploads.map((id) => byId.get(id)!);
      expect(restaged.map((item) => item.name)).toEqual([
        "docs.tar",
        "notes.md",
        "docs.tar",
      ]);
      expect(restaged.map((item) => item.saved)).toEqual([
        first.saved,
        middle.saved,
        second.saved,
      ]);
      expect(restaged.map((item) => item.files)).toEqual([2, 1, 2]);
      expect(restaged.map((item) => item.folder)).toEqual(["docs", "", ""]);
      const listed = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/uploads`,
      );
      expect(listed.status).toBe(200);
      expect((await listed.json()).items).toEqual(restaged);
      expect(
        restaged.every((item) => item.expiresAt! > chat.app.now.value),
      ).toBe(true);
      expect(files(chat, copied.session.id)).toEqual([
        { name: "later.md", text: "keep in the copied tree" },
      ]);
      const edited = await send(
        chat,
        copied.session.id,
        copied.draftUploads,
        "edited instructions",
      );
      expect(edited.detail.messages[0]?.uploads).toEqual(user.uploads);
      expect(messages(edited.script)[1]?.content).toBe(
        `edited instructions\n\n${uploadsBlock(user.uploads!)}`,
      );
      expect(files(chat, copied.session.id)).toEqual(
        files(chat, source.sessionId),
      );
      expect(staged(chat)).toEqual([]);
      expect(chat.app.knowledge.uploads.read(source.sessionId)).toEqual(
        original,
      );
      await finish(chat, copied.session.id, edited.script);
    } finally {
      await close(chat);
    }
  });

  test.each(["", "bundle"])(
    "folder %j survives a copied fork and partial replacement before restaging",
    async (folder) => {
      const chat = await chatApp();
      try {
        const item = await stage(
          chat,
          "bundle.tar",
          await new Bun.Archive({
            ...(folder ? { "root.md": "replace later" } : {}),
            "bundle/keep.md": "keep",
            "bundle/replace.md": "replace later",
          }).bytes(),
        );
        expect(item.folder).toBe(folder);
        const source = await start(chat, [item.id]);
        await finish(chat, source.sessionId, source.script);
        const answer = chat.app.sessions.messages(source.sessionId).at(-1)!;
        const copied = await fork(chat, source.sessionId, answer.id);
        const copiedUser = copied.messages.find((row) => row.kind === "user")!;
        const replacement = await stage(
          chat,
          "bundle.tar",
          await new Bun.Archive({
            ...(folder ? { "root.md": "new" } : {}),
            "bundle/replace.md": "new",
          }).bytes(),
        );
        const next = await send(chat, copied.session.id, [replacement.id]);
        await finish(chat, copied.session.id, next.script);
        const nested = await fork(chat, copied.session.id, copiedUser.id);
        const response = await chat.member.call(
          "GET",
          `/api/projects/${chat.projectId}/uploads`,
        );
        expect(response.status).toBe(200);
        expect((await response.json()).items).toEqual([
          expect.objectContaining({
            id: nested.draftUploads[0],
            folder,
            files: 1,
            saved: [`${folder ? `${folder}/` : ""}bundle/keep.md`],
          }),
        ]);
        expect(nested.draftUploads).toHaveLength(1);
      } finally {
        await close(chat);
      }
    },
  );

  test("forking a copied user turn restages the files under its new message identity", async () => {
    const chat = await chatApp();
    try {
      const item = await stage(chat, "source.md", "keep through every fork");
      const source = await start(chat, [item.id]);
      await finish(chat, source.sessionId, source.script);
      const rows = chat.app.sessions.messages(source.sessionId);
      const answer = rows.find((row) => row.slot === "answer")!;
      const copied = await fork(chat, source.sessionId, answer.id);
      const copiedUser = copied.messages.find((row) => row.kind === "user")!;
      expect(copiedUser.id).not.toBe(rows[0]!.id);
      expect(
        chat.app.knowledge.uploads.read(copied.session.id).entries[0]!
          .messageId,
      ).toBe(copiedUser.id);

      const nested = await fork(chat, copied.session.id, copiedUser.id);
      expect(nested.draftUploads).toHaveLength(1);
      expect(files(chat, nested.session.id)).toEqual([]);
      const restaged = staged(chat).find(
        (entry) => entry.id === nested.draftUploads[0],
      )!;
      expect(restaged).toMatchObject({
        name: "source.md",
        files: 1,
        saved: ["source.md"],
      });
      const edited = await send(
        chat,
        nested.session.id,
        nested.draftUploads,
        "a recursively edited turn",
      );
      expect(edited.detail.messages[0]?.uploads).toEqual(rows[0]!.uploads);
      expect(messages(edited.script)[1]?.content).toBe(
        `a recursively edited turn\n\n${uploadsBlock(rows[0]!.uploads!)}`,
      );
      expect(files(chat, nested.session.id)).toEqual(
        files(chat, source.sessionId),
      );
      await finish(chat, nested.session.id, edited.script);
    } finally {
      await close(chat);
    }
  });

  test.each([
    { limit: "files", values: { uploadFiles: 10 }, words: "limit is 10" },
    {
      limit: "bytes",
      values: { uploadBytes: 1024 * 1024 },
      words: `limit is ${1024 * 1024}`,
    },
  ])("lowering the $limit cap refuses the whole fork", async (caps) => {
    const chat = await chatApp();
    try {
      const item = stageFiles(
        chat,
        "large-tree.tar",
        Array.from({ length: 11 }, (_, i) => ({
          name: `large-tree/file-${i}.md`,
          text: "x".repeat(100 * 1024),
        })),
      );
      const source = await start(chat, [item.id]);
      await finish(chat, source.sessionId, source.script);
      await setLimits(chat, caps.values);
      const before = chat.app.knowledge.uploads.read(source.sessionId);
      const rows = chat.app.sessions.messages(source.sessionId);
      const sends = chat.app.db
        .query("select * from sends order by rowid")
        .all();
      for (const point of [rows[0]!, rows.at(-1)!]) {
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${source.sessionId}/fork`,
          { body: { messageId: point.id, agentId: chat.agentId } },
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain(caps.words);
        expect(chat.app.db.query("select id from sessions").all()).toEqual([
          { id: source.sessionId },
        ]);
        expect(
          chat.app.db.query("select session_id from session_uploads").all(),
        ).toEqual([{ session_id: source.sessionId }]);
        expect(chat.app.knowledge.uploads.read(source.sessionId)).toEqual(
          before,
        );
        expect(chat.app.sessions.messages(source.sessionId)).toEqual(rows);
        expect(
          chat.app.db.query("select * from sends order by rowid").all(),
        ).toEqual(sends);
        expect(staged(chat)).toEqual([]);
        expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
      }
    } finally {
      await close(chat);
    }
  });
});
