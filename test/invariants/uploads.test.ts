// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { subscribe } from "../../src/server/lib/bus.ts";
import { DEFAULT_LIMITS, limitsArea } from "../../src/server/limits/index.ts";
import type { SessionDetail } from "../../src/shared/contracts/session.ts";
import {
  type ChatApp,
  chatApp,
  setLimits,
  waitScript,
} from "../helpers/chat.ts";
import { finish, stageFiles } from "../server/runner/uploads-helpers.ts";

function stage(chat: ChatApp, files: { name: string; text: string }[]) {
  return stageFiles(chat, "files.zip", files);
}

const send = (chat: ChatApp, uploads: string[], sessionId?: string) =>
  chat.member.call(
    "POST",
    sessionId ? `/api/sessions/${sessionId}/messages` : "/api/sessions",
    {
      body: sessionId
        ? { message: "read the files", uploads }
        : {
            projectId: chat.projectId,
            agentId: chat.agentId,
            message: "read the files",
            uploads,
          },
    },
  );

describe("upload claim atomicity", () => {
  for (const existing of [false, true]) {
    test.serial(
      `a failed user write restores staging and ${existing ? "the existing" : "the new"} tree`,
      async () => {
        const chat = await chatApp();
        let stop = () => {};
        try {
          let sessionId: string | undefined;
          if (existing) {
            const first = stage(chat, [{ name: "notes", text: "before" }]);
            const response = await send(chat, [first.id!]);
            expect(response.status).toBe(201);
            sessionId = ((await response.json()) as SessionDetail).session.id;
            await finish(chat, sessionId, await waitScript(chat.scripted, 1));
          }
          const store = chat.app.sessions;
          const before = sessionId ? store.byId(sessionId) : null;
          const tree = chat.app.knowledge.uploadsOf(sessionId ?? "absent");
          const messages = sessionId ? store.messages(sessionId) : [];
          const staged = stage(chat, [
            { name: "notes", text: "after" },
            { name: "extra", text: "new" },
          ]);
          const events: unknown[] = [];
          stop = subscribe((event) => events.push(event));
          const original = store.addUserMessage.bind(store);
          let claimed = false;
          store.addUserMessage = (fields) => {
            expect(
              chat.app.knowledge.uploadsOf(fields.sessionId).revision,
            ).toBe(tree.revision + 1);
            expect(
              chat.app.knowledge.listUploads(chat.projectId, chat.memberId)
                .items,
            ).toEqual([]);
            claimed = true;
            original(fields);
            throw new Error("user write failed after claim");
          };
          try {
            await expect(send(chat, [staged.id!], sessionId)).rejects.toThrow(
              "user write failed after claim",
            );
          } finally {
            store.addUserMessage = original;
          }
          expect(claimed).toBe(true);
          expect(events).toEqual([]);
          expect(chat.app.runner.registry.size).toBe(0);
          expect(store.count(chat.projectId)).toBe(existing ? 1 : 0);
          expect(chat.app.knowledge.uploadsOf(sessionId ?? "absent")).toEqual(
            tree,
          );
          if (sessionId) {
            expect(store.byId(sessionId)).toEqual(before);
            expect(store.messages(sessionId)).toEqual(messages);
          } else {
            expect(
              chat.app.db.query("select * from session_uploads").all(),
            ).toEqual([]);
          }
          expect(
            chat.app.knowledge.listUploads(chat.projectId, chat.memberId).items,
          ).toEqual([staged]);
          const retried = await send(chat, [staged.id!], sessionId);
          expect(retried.status).toBe(201);
          const detail: SessionDetail = await retried.json();
          expect(
            detail.messages.filter((row) => row.kind === "user").at(-1)
              ?.uploads,
          ).toMatchObject([{ files: 2, saved: ["notes", "extra"] }]);
          stop();
          await finish(
            chat,
            detail.session.id,
            await waitScript(chat.scripted, existing ? 2 : 1),
          );
        } finally {
          stop();
          await chat.app.shutdown();
          chat.app.db.close();
        }
      },
    );
  }

  for (const change of ["expired", "deleted"] as const) {
    test.serial(`rechecks an item ${change} after preflight`, async () => {
      const chat = await chatApp();
      const staged = stage(chat, [{ name: "notes", text: "original" }]);
      const registry = chat.app.runner.registry;
      const original = registry.set.bind(registry);
      const events: unknown[] = [];
      const stop = subscribe((event) => events.push(event));
      let preflight = false;
      const check = chat.app.knowledge.checkUploads;
      chat.app.knowledge.checkUploads = (...args) => {
        check(...args);
        preflight = true;
      };
      registry.set = (active) => {
        expect(preflight).toBe(true);
        original(active);
        if (change === "expired") chat.app.now.value = staged.expiresAt!;
        else {
          chat.app.knowledge.removeUpload(
            chat.projectId,
            chat.memberId,
            staged.id!,
          );
        }
      };
      try {
        const response = await send(chat, [staged.id!]);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "an attached file is gone, add it again",
        });
        expect(events).toEqual([]);
        expect(registry.size).toBe(0);
        expect(chat.app.sessions.count(chat.projectId)).toBe(0);
        expect(
          chat.app.db.query("select * from session_uploads").all(),
        ).toEqual([]);
        expect(
          chat.app.db.query("select * from upload_staged").all(),
        ).toHaveLength(change === "expired" ? 1 : 0);
      } finally {
        registry.set = original;
        chat.app.knowledge.checkUploads = check;
        stop();
        await chat.app.shutdown();
        chat.app.db.close();
      }
    });
  }

  for (const fixture of [
    {
      name: "knowledgeFileBytes",
      limits: { knowledgeFileBytes: 4096 },
      files: [{ name: "notes", text: "a".repeat(4097) }],
      error: "notes is 4097 bytes, the limit is 4096",
    },
    {
      name: "uploadBytes",
      limits: { uploadBytes: 1024 * 1024 },
      files: [
        ...Array.from({ length: 4 }, (_, i) => ({
          name: `file-${i}`,
          text: "a".repeat(256 * 1024),
        })),
        { name: "extra", text: "x" },
      ],
      error: "the uploads would be 1048577 bytes, the limit is 1048576",
    },
    {
      name: "uploadFiles",
      limits: { uploadFiles: 10 },
      files: Array.from({ length: 11 }, (_, i) => ({
        name: `file-${i}`,
        text: "",
      })),
      error: "the uploads would have 11 files, the limit is 10",
    },
  ]) {
    test.serial(
      `the claim checks ${fixture.name} lowered after preflight`,
      async () => {
        const chat = await chatApp();
        const staged = stage(chat, fixture.files);
        const registry = chat.app.runner.registry;
        const original = registry.set.bind(registry);
        const limits = limitsArea({
          db: chat.app.db,
          clock: () => chat.app.now.value,
        });
        registry.set = (active) => {
          original(active);
          limits.set(
            { ...DEFAULT_LIMITS, ...fixture.limits },
            chat.app.now.value,
          );
        };
        const events: unknown[] = [];
        const stop = subscribe((event) => events.push(event));
        try {
          const response = await send(chat, [staged.id!]);
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: fixture.error });
          expect(events).toEqual([]);
          expect(registry.size).toBe(0);
          expect(chat.app.sessions.count(chat.projectId)).toBe(0);
          expect(
            chat.app.knowledge.listUploads(chat.projectId, chat.memberId).items,
          ).toEqual([staged]);
          expect(
            chat.app.db.query("select * from session_uploads").all(),
          ).toEqual([]);
        } finally {
          registry.set = original;
          stop();
          await chat.app.shutdown();
          chat.app.db.close();
        }
      },
    );
  }

  test("a claim shrinks a tree over lowered file, byte and count caps", async () => {
    const chat = await chatApp();
    try {
      const initial = stage(
        chat,
        Array.from({ length: 11 }, (_, i) => ({
          name: `file-${i}`,
          text: "a".repeat(100 * 1024),
        })),
      );
      const first = await send(chat, [initial.id!]);
      expect(first.status).toBe(201);
      const { session }: SessionDetail = await first.json();
      await finish(chat, session.id, await waitScript(chat.scripted, 1));
      const replacement = stage(chat, [
        { name: "file-0", text: "b".repeat(50_000) },
      ]);
      await setLimits(chat, {
        knowledgeFileBytes: 4096,
        uploadBytes: 1024 * 1024,
        uploadFiles: 10,
      });
      const claimed = await send(chat, [replacement.id!], session.id);
      expect(claimed.status).toBe(201);
      await finish(chat, session.id, await waitScript(chat.scripted, 2));
      const tree = chat.app.knowledge.uploadsOf(session.id);
      expect(tree).toMatchObject({
        revision: 2,
        files: 11,
        bytes: 10 * 100 * 1024 + 50_000,
      });
      const without = await send(chat, [], session.id);
      expect(without.status).toBe(201);
      await finish(chat, session.id, await waitScript(chat.scripted, 3));
      expect(chat.app.knowledge.uploadsOf(session.id)).toEqual(tree);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });
});
