// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { OverviewResponse } from "../../../src/shared/api/admin.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun as settle,
  startRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp, startChat } from "../../helpers/chat.ts";

const DAY = 86_400_000;
const KEPT = DEFAULT_LIMITS.archivedDeleteDays;

async function doneChat(
  chat: ChatApp,
  message = "hello",
  client = chat.member,
) {
  const started = await startChat(chat, message, client);
  started.script.reply("the answer");
  await settle(chat, started.sessionId);
  return started.sessionId;
}

async function ran(chat: ChatApp, automationId: string) {
  const run = await startRun(chat, automationId);
  run.main.reply("healthy");
  await settle(chat, run.sessionId);
  return run.sessionId;
}

function archivedAgo(chat: ChatApp, id: string, days: number) {
  const at = chat.app.now.value - days * DAY;
  chat.app.db
    .query(
      `update sessions set archived_at = ?, archived_reason = 'manual',
         last_activity_at = ? where id = ?`,
    )
    .run(at, at, id);
}

function idleAgo(chat: ChatApp, id: string, days: number) {
  chat.app.db
    .query("update sessions set last_activity_at = ? where id = ?")
    .run(chat.app.now.value - days * DAY, id);
}

const usageOf = (chat: ChatApp, id: string) =>
  chat.app.db
    .query<{ n: number }, [string]>(
      "select count(*) as n from usage where session_id = ?",
    )
    .get(id)!.n;

describe("the chats sweep deletes", () => {
  test.serial(
    "archived chats and orphan runs past the limit, one event each",
    async () => {
      const { events: logs, logFactory } = collectLogs();
      const chat = await chatApp({ logFactory });
      chat.app.automationScheduler.stop();
      const gone = await doneChat(chat, "gone");
      const kept = await doneChat(chat, "kept");
      const live = await doneChat(chat, "live");
      archivedAgo(chat, gone, KEPT + 1);
      archivedAgo(chat, kept, KEPT - 1);
      idleAgo(chat, live, 1);

      const orphaned = await createAutomation(chat, { name: "orphaned" });
      const oldOrphan = await ran(chat, orphaned.id);
      const newOrphan = await ran(chat, orphaned.id);
      expect(
        (await chat.member.call("DELETE", `/api/automations/${orphaned.id}`))
          .status,
      ).toBe(204);
      idleAgo(chat, oldOrphan, KEPT + 1);
      idleAgo(chat, newOrphan, KEPT - 1);
      // a live task's runs keep its own retention, whatever their age
      const living = await createAutomation(chat, {
        name: "living",
        retentionDays: 365,
      });
      const livingRun = await ran(chat, living.id);
      idleAgo(chat, livingRun, KEPT + 100);

      const events: BusEvent[] = [];
      const unsubscribe = subscribe((event) => events.push(event), silent);
      chat.app.sweep();
      unsubscribe();
      expect(
        events.filter((event) => event.type === "session.deleted"),
      ).toEqual([
        {
          type: "session.deleted",
          data: { projectId: chat.projectId, sessionId: gone },
        },
        {
          type: "session.deleted",
          data: { projectId: chat.projectId, sessionId: oldOrphan },
        },
      ]);
      for (const id of [gone, oldOrphan]) {
        expect(chat.app.sessions.byId(id)).toBeNull();
        expect(usageOf(chat, id)).toBe(1);
      }
      for (const id of [kept, live, newOrphan, livingRun]) {
        expect(chat.app.sessions.byId(id)).not.toBeNull();
      }
      expect(
        logs.filter((event) => event.area === "sweep" && event.msg === "sweep"),
      ).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({
            chats_deleted: 1,
            runs_deleted: 1,
          }),
        }),
      ]);

      // the day after, the other chat's time is up
      chat.app.now.value += 2 * DAY;
      chat.app.sweep();
      expect(chat.app.sessions.byId(kept)).toBeNull();
      expect(chat.app.sessions.byId(newOrphan)).toBeNull();
      expect(chat.app.sessions.byId(livingRun)).not.toBeNull();
      await chat.app.shutdown();
    },
  );

  test("the delete takes what the chat held and nulls what pointed at it", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat);
    const run = await ran(chat, automation.id);
    expect(chat.app.automations.byId(automation.id)!.lastRunSessionId).toBe(
      run,
    );
    const { db } = chat.app;
    const messageId = db
      .query<{ id: string }, [string]>(
        "select id from messages where session_id = ? limit 1",
      )
      .get(run)!.id;
    db.query(
      `insert into session_scratch
         (session_id, cwd, revision, bytes, files, used_at)
       values (?, '/', 1, 1, 1, 0)`,
    ).run(run);
    db.query(
      `insert into session_scratch_files (session_id, path, data, mode)
       values (?, 'a', x'00', 420)`,
    ).run(run);
    db.query(
      `insert into session_uploads (session_id, revision, bytes, files)
       values (?, 1, 0, 0)`,
    ).run(run);
    db.query(
      `insert into mcp_kept_files (message_id, position, session_id, folder,
         dir, name, bytes, text)
       values (?, 0, ?, 1, 'd', 'n', 1, 'x')`,
    ).run(messageId, run);
    db.query(
      `insert into opened_files (message_id, position, path, kind, bytes,
         lines, text)
       values (?, 0, '/tmp/a.md', 'markdown', 1, 1, 'x')`,
    ).run(messageId);
    db.query(
      "insert into memory_views (session_id, snapshot, seen) values (?, '', '')",
    ).run(run);
    const deleted = chat.app.sessions.remove(run);
    expect(deleted).toEqual({
      type: "session.deleted",
      data: { projectId: chat.projectId, sessionId: run },
    });
    expect(
      db
        .query<{ n: number }, [string]>(
          "select count(*) as n from opened_files where message_id = ?",
        )
        .get(messageId)!.n,
    ).toBe(0);
    for (const table of [
      "sends",
      "messages",
      "session_scratch",
      "session_scratch_files",
      "session_uploads",
      "mcp_kept_files",
      "memory_views",
    ]) {
      expect(
        chat.app.db
          .query<{ n: number }, [string]>(
            `select count(*) as n from ${table} where session_id = ?`,
          )
          .get(run)!.n,
      ).toBe(0);
    }
    expect(
      chat.app.automations.byId(automation.id)!.lastRunSessionId,
    ).toBeNull();
    expect(usageOf(chat, run)).toBe(1);
    expect(chat.app.sessions.remove(run)).toBeNull();
    await chat.app.shutdown();
  });

  test("a running chat is left alone", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "streaming");
    started.script.content("partial");
    archivedAgo(chat, started.sessionId, KEPT + 1);
    expect(chat.app.sessions.remove(started.sessionId)).toBe("running");
    chat.app.sweep();
    expect(chat.app.sessions.byId(started.sessionId)).not.toBeNull();
    started.script.reply(" done");
    await settle(chat, started.sessionId);
    await chat.app.shutdown();
  });
});

describe("usage is permanent", () => {
  async function overview(chat: ChatApp): Promise<OverviewResponse> {
    // the answer is kept a minute per zone
    chat.app.now.value += 61_000;
    const res = await chat.admin.call("GET", "/api/admin/overview?tz=UTC");
    expect(res.status).toBe(200);
    return res.json();
  }

  test("no delete and no regenerate lowers the cost", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const personal = await doneChat(chat, "personal");
    const regenerated = await doneChat(chat, "again");
    const automation = await createAutomation(chat, { retentionDays: 1 });
    const run = await ran(chat, automation.id);
    const dropped = await createAutomation(chat, { name: "dropped" });
    await ran(chat, dropped.id);
    const created = await chat.admin.call("POST", "/api/projects", {
      body: { name: "ops" },
    });
    expect(created.status).toBe(201);
    const team = (await created.json()).project.id as string;
    const teamChat = await startChat(chat, "team", chat.admin, team);
    teamChat.script.reply("the answer");
    await settle(chat, teamChat.sessionId);
    chat.app.db.run("update usage set cost = 0.25");

    const before = await overview(chat);
    expect(before.totals.cost).toBeCloseTo(1.25);
    expect(
      (await chat.member.call("DELETE", `/api/sessions/${personal}`)).status,
    ).toBe(200);
    idleAgo(chat, run, 2);
    expect(chat.app.automationScheduler.sweep()).toBe(1);
    expect(chat.app.sessions.byId(run)).toBeNull();
    expect(
      (
        await chat.member.call(
          "DELETE",
          `/api/automations/${dropped.id}?runs=delete`,
        )
      ).status,
    ).toBe(204);
    expect(
      (await chat.admin.call("DELETE", `/api/projects/${team}`)).status,
    ).toBe(200);
    const pending = chat.scripted.next();
    expect(
      (
        await chat.member.call(
          "POST",
          `/api/sessions/${regenerated}/regenerate`,
        )
      ).status,
    ).toBe(201);
    (await pending).reply("another answer");
    await settle(chat, regenerated);
    chat.app.db.run("update usage set cost = 0.25 where cost is null");

    const after = await overview(chat);
    // the regenerated turn adds its own round; nothing is taken away
    expect(after.totals.cost).toBeCloseTo(1.5);
    expect(after.totals.promptTokens).toBeGreaterThan(
      before.totals.promptTokens,
    );
    expect(after.by.projects).toContainEqual(
      expect.objectContaining({
        id: null,
        name: null,
        owner: null,
        deleted: true,
      }),
    );
    await chat.app.shutdown();
  });
});
