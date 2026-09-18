// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, open, transact } from "../../../src/server/db/index.ts";
import { ScratchStore } from "../../../src/server/knowledge/index.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { createAutomation, startRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import { setup } from "./helpers.ts";

const binary = new Uint8Array([0, 255, 128, 192, 10, 13, 1, 254]);
const encoded = Buffer.from(binary).toString("base64");
const entries = [
  { path: "work/data.bin", data: binary, mode: 0o700 },
  { path: "work/empty", data: new Uint8Array(), mode: 0o600 },
];
const writeScratch =
  `mkdir -p /tmp/work && printf '${encoded}' | base64 -d > /tmp/work/data.bin` +
  " && touch /tmp/work/empty && chmod 700 /tmp/work/data.bin" +
  " && chmod 600 /tmp/work/empty && cd /tmp/work";
const readScratch = "pwd; base64 data.bin; stat -c %a data.bin; test -f empty";
const emptyScratch = "pwd; find /tmp -type f; test ! -e /tmp/work/data.bin";

function state(db: Db, sessionId: string) {
  return {
    ...new ScratchStore(db).read(sessionId),
    usedAt:
      db
        .query<{ usedAt: number }, [string]>(
          "select used_at as usedAt from session_scratch where session_id = ?",
        )
        .get(sessionId)?.usedAt ?? null,
  };
}

function rows(db: Db, sessionId: string) {
  return db
    .query<{ scratches: number; files: number }, [string, string]>(
      `select
         (select count(*) from session_scratch where session_id = ?) as scratches,
         (select count(*) from session_scratch_files where session_id = ?) as files`,
    )
    .get(sessionId, sessionId);
}

async function finish(chat: ChatApp, sessionId: string, script: Script) {
  const send = chat.app.runner.registry.get(sessionId)!;
  script.reply("done");
  await send.drained;
  expect(chat.app.sessions.byId(sessionId)?.status).toBe("done");
}

async function bash(
  chat: ChatApp,
  sessionId: string,
  script: Script,
  command: string,
  content = "exit 0",
) {
  const count = chat.scripted.scripts.length;
  script.toolRound([
    {
      id: `bash-${count}`,
      name: "bash",
      arguments: JSON.stringify({ command }),
    },
  ]);
  script.end();
  const answer = await waitScript(chat.scripted, count + 1);
  expect(
    chat.app.sessions
      .messages(sessionId)
      .findLast((message) => message.kind === "tool"),
  ).toMatchObject({ status: "done", error: null, content });
  await finish(chat, sessionId, answer);
}

async function scratchChat(chat: ChatApp) {
  const started = await startChat(chat, "prepare working files");
  await bash(chat, started.sessionId, started.script, writeScratch);
  expect(state(chat.app.db, started.sessionId)).toEqual({
    cwd: "/tmp/work",
    revision: 1,
    bytes: binary.byteLength,
    files: 2,
    entries,
    usedAt: chat.app.now.value,
  });
  return started.sessionId;
}

async function nextMessage(chat: ChatApp, sessionId: string) {
  const count = chat.scripted.scripts.length;
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message: "inspect working files" } },
  );
  expect(response.status).toBe(201);
  return waitScript(chat.scripted, count + 1);
}

async function close(chat: ChatApp) {
  await chat.app.shutdown();
  chat.app.db.close();
}

describe("scratch lifecycle", () => {
  test.serial(
    "deleting a chat through its route cascades both scratch tables",
    async () => {
      const chat = await chatApp();
      try {
        const sessionId = await scratchChat(chat);
        const keptId = await scratchChat(chat);
        const kept = state(chat.app.db, keptId);
        expect(rows(chat.app.db, sessionId)).toEqual({
          scratches: 1,
          files: 2,
        });

        const response = await chat.member.call(
          "DELETE",
          `/api/sessions/${sessionId}`,
        );
        expect(response.status).toBe(200);
        expect(chat.app.sessions.byId(sessionId)).toBeNull();
        expect(rows(chat.app.db, sessionId)).toEqual({
          scratches: 0,
          files: 0,
        });
        expect(chat.app.sessions.byId(keptId)?.status).toBe("done");
        expect(state(chat.app.db, keptId)).toEqual(kept);
        expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
      } finally {
        await close(chat);
      }
    },
  );

  test.serial(
    "run retention cascades both tables and keeps a newer run's scratch",
    async () => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      try {
        const automation = await createAutomation(chat, { retentionDays: 1 });
        const first = await startRun(chat, automation.id);
        await bash(chat, first.sessionId, first.main, writeScratch);
        expect(rows(chat.app.db, first.sessionId)).toEqual({
          scratches: 1,
          files: 2,
        });

        chat.app.now.value += 86_400_001;
        const second = await startRun(chat, automation.id);
        expect(rows(chat.app.db, second.sessionId)).toEqual({
          scratches: 0,
          files: 0,
        });
        await bash(
          chat,
          second.sessionId,
          second.main,
          `${emptyScratch} && printf fresh > /tmp/new`,
          "/knowledge\n\nexit 0",
        );
        const kept = state(chat.app.db, second.sessionId);
        expect(kept.entries.map((file) => file.path)).toEqual(["new"]);

        expect(chat.app.automationScheduler.sweep()).toBe(1);
        expect(chat.app.sessions.byId(first.sessionId)).toBeNull();
        expect(rows(chat.app.db, first.sessionId)).toEqual({
          scratches: 0,
          files: 0,
        });
        expect(chat.app.sessions.byId(second.sessionId)?.status).toBe("done");
        expect(state(chat.app.db, second.sessionId)).toEqual(kept);
        expect(chat.app.automations.byId(automation.id)).not.toBeNull();
        expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
      } finally {
        await close(chat);
      }
    },
  );

  test.serial(
    "regeneration keeps the discarded answer's scratch and mounts it again",
    async () => {
      const chat = await chatApp();
      try {
        const sessionId = await scratchChat(chat);
        const before = state(chat.app.db, sessionId);
        const oldSend = chat.app.sessions.lastSend(sessionId)!;
        chat.app.now.value += 100;
        const count = chat.scripted.scripts.length;
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${sessionId}/regenerate`,
        );
        expect(response.status).toBe(201);
        expect(chat.app.sessions.send(oldSend.id)).toBeNull();
        expect(state(chat.app.db, sessionId)).toEqual(before);
        await bash(
          chat,
          sessionId,
          await waitScript(chat.scripted, count + 1),
          readScratch,
          `/tmp/work\n${encoded}\n700\n\nexit 0`,
        );
        expect(state(chat.app.db, sessionId)).toEqual({
          ...before,
          revision: before.revision + 1,
          usedAt: chat.app.now.value,
        });
      } finally {
        await close(chat);
      }
    },
  );

  test.serial(
    "compaction preserves scratch without touching its revision or last use",
    async () => {
      const chat = await chatApp();
      try {
        const sessionId = await scratchChat(chat);
        const before = state(chat.app.db, sessionId);
        chat.app.now.value += 100;
        const count = chat.scripted.scripts.length;
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${sessionId}/compact`,
        );
        expect(response.status).toBe(200);
        expect(state(chat.app.db, sessionId)).toEqual(before);
        await finish(
          chat,
          sessionId,
          await waitScript(chat.scripted, count + 1),
        );
        expect(chat.app.sessions.lastSend(sessionId)).toMatchObject({
          kind: "compact",
          status: "done",
        });
        expect(chat.app.sessions.messages(sessionId).at(-1)).toMatchObject({
          kind: "summary",
          status: "done",
        });
        expect(state(chat.app.db, sessionId)).toEqual(before);
        await bash(
          chat,
          sessionId,
          await nextMessage(chat, sessionId),
          readScratch,
          `/tmp/work\n${encoded}\n700\n\nexit 0`,
        );
        expect(state(chat.app.db, sessionId)).toEqual({
          ...before,
          revision: before.revision + 1,
          usedAt: chat.app.now.value,
        });
      } finally {
        await close(chat);
      }
    },
  );

  test.serial(
    "forking starts empty and its first command leaves the source scratch alone",
    async () => {
      const chat = await chatApp();
      try {
        const sourceId = await scratchChat(chat);
        const before = state(chat.app.db, sourceId);
        const answer = chat.app.sessions.messages(sourceId).at(-1)!;
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${sourceId}/fork`,
          { body: { messageId: answer.id, agentId: chat.agentId } },
        );
        expect(response.status).toBe(201);
        const fork: SessionDetail = await response.json();
        expect(fork.session.id).not.toBe(sourceId);
        expect(fork.session.origin).toBe("chat");
        expect(rows(chat.app.db, fork.session.id)).toEqual({
          scratches: 0,
          files: 0,
        });
        expect(state(chat.app.db, sourceId)).toEqual(before);
        await bash(
          chat,
          fork.session.id,
          await nextMessage(chat, fork.session.id),
          `${emptyScratch} && printf fork > /tmp/new`,
          "/knowledge\n\nexit 0",
        );
        expect(state(chat.app.db, fork.session.id)).toMatchObject({
          cwd: "/knowledge",
          revision: 1,
          bytes: 4,
          files: 1,
          entries: [{ path: "new", data: new TextEncoder().encode("fork") }],
        });
        expect(state(chat.app.db, sourceId)).toEqual(before);
      } finally {
        await close(chat);
      }
    },
  );

  for (const otherProject of [false, true]) {
    test.serial(
      `a second session in ${otherProject ? "another" : "the same"} project cannot see the original scratch`,
      async () => {
        const chat = await chatApp();
        try {
          const sourceId = await scratchChat(chat);
          const before = state(chat.app.db, sourceId);
          let projectId = chat.projectId;
          if (otherProject) {
            const response = await chat.admin.call("POST", "/api/projects", {
              body: { name: "scratch-isolation", description: "" },
            });
            expect(response.status).toBe(201);
            projectId = (await response.json()).project.id;
            const member = await chat.admin.call(
              "POST",
              `/api/projects/${projectId}/members`,
              { body: { userId: chat.memberId } },
            );
            expect(member.status).toBe(201);
          }
          const second = await startChat(
            chat,
            "inspect working files",
            chat.member,
            projectId,
          );
          expect(second.sessionId).not.toBe(sourceId);
          expect(second.detail.session.projectId).toBe(projectId);
          expect(rows(chat.app.db, second.sessionId)).toEqual({
            scratches: 0,
            files: 0,
          });
          await bash(
            chat,
            second.sessionId,
            second.script,
            `${emptyScratch} && printf second > /tmp/new`,
            "/knowledge\n\nexit 0",
          );
          expect(state(chat.app.db, second.sessionId)).toMatchObject({
            cwd: "/knowledge",
            revision: 1,
            bytes: 6,
            files: 1,
            entries: [
              { path: "new", data: new TextEncoder().encode("second") },
            ],
          });
          expect(state(chat.app.db, sourceId)).toEqual(before);
        } finally {
          await close(chat);
        }
      },
    );
  }

  test("bytes, modes, cwd, revision and last use survive a closed and reopened file database", () => {
    const fixture = setup();
    const directory = join("test", `.scratch-lifecycle-${crypto.randomUUID()}`);
    let db: Db | undefined;
    try {
      mkdirSync(directory);
      const path = join(directory, "scratch.sqlite");
      writeFileSync(path, fixture.db.serialize());
      fixture.db.close();
      db = open(path);
      const scratch = new ScratchStore(db);
      transact(db, () => ({
        result: scratch.write(
          fixture.session.id,
          0,
          { written: entries, removed: [], cwd: "/tmp" },
          100,
        ),
      }));
      transact(db, () => ({
        result: scratch.write(
          fixture.session.id,
          1,
          { written: [], removed: [], cwd: "/tmp/work" },
          200,
        ),
      }));
      const before = state(db, fixture.session.id);
      expect(before).toEqual({
        cwd: "/tmp/work",
        revision: 2,
        bytes: binary.byteLength,
        files: 2,
        entries,
        usedAt: 200,
      });

      db.close();
      db = open(path);
      expect(state(db, fixture.session.id)).toEqual(before);
      expect(rows(db, fixture.session.id)).toEqual({ scratches: 1, files: 2 });
      expect(db.query("pragma foreign_key_check").all()).toEqual([]);
      const reopened = new ScratchStore(db);
      transact(db, () => ({
        result: reopened.write(
          fixture.session.id,
          before.revision,
          { written: [], removed: [], cwd: before.cwd },
          300,
        ),
      }));
      expect(state(db, fixture.session.id)).toEqual({
        ...before,
        revision: 3,
        usedAt: 300,
      });
    } finally {
      db?.close();
      fixture.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
