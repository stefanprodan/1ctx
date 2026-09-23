// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The storage answer over a composed app: the area map against the
// schema, the scan's pages, the stored sums against the rows, the days
// of a zone, and what a personal project never gives away.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { MESSAGE_BYTES, scan } from "../../../src/server/overview/scan.ts";
import { STORAGE_TABLES } from "../../../src/server/overview/storage.ts";
import type {
  StorageAreaKey,
  StorageResponse,
} from "../../../src/shared/api/admin.ts";
import { testApp } from "../../helpers/app.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { type ChatApp, chatApp, startChat } from "../../helpers/chat.ts";

const mapped = () => Object.values(STORAGE_TABLES).flat();

async function storage(chat: ChatApp, tz = "UTC"): Promise<StorageResponse> {
  const res = await chat.admin.call(
    "GET",
    `/api/admin/storage?tz=${encodeURIComponent(tz)}`,
  );
  expect(res.status).toBe(200);
  return res.json();
}

const messageBytes = (chat: ChatApp, sessionId: string): number =>
  chat.app.db
    .query<{ bytes: number }, [string]>(
      `select coalesce(sum(${MESSAGE_BYTES}), 0) as bytes from messages where session_id = ?`,
    )
    .get(sessionId)!.bytes;

async function settledChat(chat: ChatApp, projectId = chat.projectId) {
  const { script, sessionId } = await startChat(
    chat,
    "hello there",
    chat.member,
    projectId,
  );
  script.reply("a reply with some words in it");
  await settleRun(chat, sessionId);
  return sessionId;
}

// a clock moved past the logins' life needs them again
async function relogin(chat: ChatApp) {
  await chat.admin.login("admin", "hunter2-test");
  await chat.member.login("casey", "pw");
}

async function team(chat: ChatApp, name: string): Promise<string> {
  const res = await chat.admin.call("POST", "/api/projects", {
    body: { name },
  });
  expect(res.status).toBe(201);
  const { project } = await res.json();
  const added = await chat.admin.call(
    "POST",
    `/api/projects/${project.id}/members`,
    { body: { userId: chat.memberId } },
  );
  expect(added.status).toBe(201);
  return project.id as string;
}

describe("the storage area map", () => {
  test("names every table the migrations create, once, and no other", async () => {
    const app = await testApp();
    const tables = app.db
      .query<{ name: string }, []>(
        "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%'",
      )
      .all()
      .map((row) => row.name)
      .concat("sqlite_schema")
      .sort();
    const named = mapped().sort();
    expect(new Set(named).size).toBe(named.length);
    expect(named).toEqual(tables);
  });
});

describe("the storage scan", () => {
  test("answers bytes per table and index from dbstat", async () => {
    const app = await testApp();
    const result = scan(app.db, { now: app.now.value, since: 0 });
    const tables = result.pages.filter((row) => row.kind === "table");
    for (const name of mapped()) {
      const row = tables.find((row) => row.name === name);
      expect(row?.bytes, name).toBeGreaterThan(0);
      expect(row?.table).toBe(name);
    }
    const index = result.pages.find((row) => row.name === "messages_answer");
    expect(index).toMatchObject({ kind: "index", table: "messages" });
    const auto = result.pages.find((row) =>
      row.name.startsWith("sqlite_autoindex_users_"),
    );
    expect(auto).toMatchObject({ kind: "index", table: "users" });
    expect(result.rows.users).toBe(1);
    expect(result.rows.sqlite_schema).toBeGreaterThan(30);
    expect(result.file).toMatchObject({
      name: ":memory:",
      bytes: 0,
      walBytes: 0,
      pageSize: 4096,
      lastMigration: expect.stringMatching(/^\d{4}-/),
    });
    expect(result.file.pages).toBeGreaterThan(0);
  });

  test("sums a skill's body and its files apart", async () => {
    const app = await testApp();
    const now = app.now.value;
    app.db
      .query(
        `insert into skills (id, name, description, body, license, compatibility,
           metadata, allowed_tools, source_kind, source_url, source_select,
           source_digest, digest, dropped, fetched_at, created_at)
         values ('s1', 'notes', '', '0123456789', '', '', '{}', '', 'file',
           'https://example.test/SKILL.md', '', '', '', '[]', ?, ?)`,
      )
      .run(now, now);
    const file = app.db.query(
      "insert into skill_files (skill_id, path, content, bytes) values ('s1', ?, 'abcde', 5)",
    );
    for (const path of ["a.md", "b.md", "c.md"]) file.run(path);
    const result = scan(app.db, { now, since: 0 });
    const added = result.slots.reduce((sum, [, bytes]) => sum + bytes, 0);
    expect(added).toBe(10 + 3 * 5);
  });
});

describe("the storage answer", () => {
  test("groups areas largest first with their indexes and rows", async () => {
    const chat = await chatApp();
    await settledChat(chat);
    const body = await storage(chat);
    expect(body.areas.map((area) => area.key).sort()).toEqual(
      [...Object.keys(STORAGE_TABLES)].sort() as StorageAreaKey[],
    );
    for (let i = 1; i < body.areas.length; i++) {
      expect(body.areas[i - 1]!.bytes).toBeGreaterThanOrEqual(
        body.areas[i]!.bytes,
      );
    }
    const chats = body.areas.find((area) => area.key === "chats")!;
    expect(chats.tables.map((table) => table.name).sort()).toEqual(
      [...STORAGE_TABLES.chats].sort(),
    );
    expect(chats.indexes.count).toBeGreaterThan(0);
    expect(chats.bytes).toBe(
      chats.tables.reduce((sum, table) => sum + table.bytes, 0) +
        chats.indexes.bytes,
    );
    expect(chats.tables.find((table) => table.name === "sessions")?.rows).toBe(
      1,
    );
    expect(body.file.journalMode).toBe("memory");
    expect(body.readAt).toBe(chat.app.now.value);
  });

  test("sums a chat's messages and names it only in a team project", async () => {
    const chat = await chatApp();
    const projectId = await team(chat, "research");
    const personal = await settledChat(chat);
    const shared = await settledChat(chat, projectId);
    const body = await storage(chat);
    const rows = body.largest.chats;
    expect(rows).toHaveLength(2);
    const teamRow = rows.find((row) => row.id === shared)!;
    expect(teamRow).toMatchObject({
      name: "hello there",
      project: "research",
      owner: null,
      bytes: messageBytes(chat, shared),
      parts: [{ part: "chats", bytes: messageBytes(chat, shared) }],
      messages: 2,
      runs: null,
      retentionDays: null,
    });
    const personalRow = rows.find((row) => row.id === null)!;
    expect(personalRow).toMatchObject({
      name: null,
      project: null,
      owner: "casey",
      bytes: messageBytes(chat, personal),
      messages: 2,
    });
    const project = body.largest.projects.find(
      (row) => row.name === "research",
    );
    expect(project).toMatchObject({
      id: projectId,
      project: null,
      owner: null,
      bytes: messageBytes(chat, shared),
      messages: null,
    });
  });

  test("sums a task's runs and splits chats from runs", async () => {
    const chat = await chatApp();
    const chatId = await settledChat(chat);
    const automation = await createAutomation(chat, { retentionDays: 14 });
    const runIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { sessionId, main } = await startRun(chat, automation.id);
      main.reply(`run ${i} finished with a report`);
      await settleRun(chat, sessionId);
      runIds.push(sessionId);
    }
    const runBytes = runIds.reduce(
      (sum, id) => sum + messageBytes(chat, id),
      0,
    );
    const body = await storage(chat);
    expect(body.largest.tasks).toEqual([
      {
        id: null,
        name: null,
        project: null,
        owner: "casey",
        bytes: runBytes,
        parts: [{ part: "runs", bytes: runBytes }],
        messages: null,
        runs: 2,
        retentionDays: 14,
      },
    ]);
    expect(body.largest.chats).toHaveLength(1);
    const kept = Object.fromEntries(
      body.retention.kept.map((row) => [row.key, row.bytes]),
    );
    const cleaned = Object.fromEntries(
      body.retention.cleaned.map((row) => [row.key, row]),
    );
    expect(kept.chats).toBe(messageBytes(chat, chatId));
    // the runs' share of the usage table's pages goes with the runs
    const usagePages = body.areas
      .flatMap((area) => area.tables)
      .find((table) => table.name === "usage")!.bytes;
    const usageRows = chat.app.db
      .query<{ total: number; runs: number }, []>(
        `select count(*) as total,
                sum(session_id in (select id from sessions where automation_id is not null)) as runs
           from usage`,
      )
      .get()!;
    expect(usageRows.runs).toBe(2);
    expect(usageRows.total).toBe(3);
    const runUsage = Math.round(
      (usagePages * usageRows.runs) / usageRows.total,
    );
    expect(runUsage).toBeGreaterThan(0);
    expect(cleaned.runs).toEqual({
      key: "runs",
      bytes: runBytes + runUsage,
      days: 14,
    });
    expect(kept.usage).toBe(usagePages - runUsage);
    expect(cleaned.scratch?.days).toBe(DEFAULT_LIMITS.scratchIdleDays);
    expect(cleaned.history?.days).toBe(DEFAULT_LIMITS.knowledgeHistoryDays);
    expect(kept.rest).toBeGreaterThan(0);
    const project = body.largest.projects[0]!;
    expect(project.parts.map((part) => part.part).sort()).toEqual([
      "chats",
      "runs",
    ]);
    expect(project.bytes).toBe(runBytes + messageBytes(chat, chatId));
  });

  test("keeps a chat's MCP files and cleans a run's with the run", async () => {
    const chat = await chatApp();
    const chatId = await settledChat(chat);
    const automation = await createAutomation(chat, { retentionDays: 3 });
    const { sessionId: runId, main } = await startRun(chat, automation.id);
    main.reply("done");
    await settleRun(chat, runId);
    const kept = chat.app.db.query(
      `insert into mcp_kept_files (message_id, position, session_id, folder, dir,
         name, bytes, text)
       select id, 0, session_id, 1, '/mcp/0001-tool', 'result.txt', ?, 'x'
         from messages where session_id = ? and kind = 'reply'`,
    );
    kept.run(700, chatId);
    kept.run(300, runId);
    const body = await storage(chat);
    const keptMcp = body.retention.kept.find((row) => row.key === "mcp");
    expect(keptMcp?.bytes).toBe(700);
    const runs = body.retention.cleaned.find((row) => row.key === "runs")!;
    expect(runs.bytes).toBeGreaterThanOrEqual(messageBytes(chat, runId) + 300);
    expect(body.largest.tasks[0]?.parts).toEqual([
      { part: "mcp", bytes: 300 },
      { part: "runs", bytes: messageBytes(chat, runId) },
    ]);
  });

  test("sums a project's live files, their versions and deleted history", async () => {
    const chat = await chatApp();
    const projectId = await team(chat, "docs");
    const base = `/api/projects/${projectId}/knowledge`;
    const first = await chat.member.call("POST", base, {
      body: { name: "notes.md", text: "one" },
    });
    expect(first.status).toBe(201);
    const { file } = await first.json();
    const replaced = await chat.member.call("PUT", `${base}/files/${file.id}`, {
      body: { text: "one and two", revision: file.revision },
    });
    expect(replaced.status).toBe(200);
    const second = await chat.member.call("POST", base, {
      body: { name: "gone.md", text: "four" },
    });
    expect(second.status).toBe(201);
    const gone = (await second.json()).file;
    const deleted = await chat.member.call(
      "DELETE",
      `${base}/files/${gone.id}`,
    );
    expect(deleted.status).toBe(204);
    const body = await storage(chat);
    const project = body.largest.projects.find((row) => row.name === "docs")!;
    // the live file, its two versions, and the deleted file's version
    expect(project.bytes).toBe(11 + 3 + 11 + 4);
    expect(project.parts).toEqual([
      { part: "knowledge", bytes: 11 + 3 + 11 },
      { part: "history", bytes: 4 },
    ]);
    const kept = body.retention.kept.find((row) => row.key === "knowledge");
    expect(kept?.bytes).toBe(11 + 3 + 11);
    const history = body.retention.cleaned.find((row) => row.key === "history");
    expect(history?.bytes).toBe(4);
  });

  test("lays the bytes added on the zone's days across a DST change", async () => {
    const chat = await chatApp();
    // New York leaves DST on 2026-11-01 at 02:00
    chat.app.now.value = Date.parse("2026-11-02T12:00:00Z");
    await relogin(chat);
    const sessionId = await settledChat(chat);
    const rows = chat.app.db
      .query<{ id: string; seq: number }, [string]>(
        "select id, seq from messages where session_id = ? order by seq",
      )
      .all(sessionId);
    expect(rows).toHaveLength(2);
    const set = chat.app.db.query(
      "update messages set created_at = ? where id = ?",
    );
    // 23:30 EDT on the 31st, and 23:30 EST on the 1st
    set.run(Date.parse("2026-11-01T03:30:00Z"), rows[0]!.id);
    set.run(Date.parse("2026-11-02T04:30:00Z"), rows[1]!.id);
    const bytesOf = (id: string) =>
      chat.app.db
        .query<{ bytes: number }, [string]>(
          `select ${MESSAGE_BYTES} as bytes from messages where id = ?`,
        )
        .get(id)!.bytes;
    const body = await storage(chat, "America/New_York");
    expect(body.days).toHaveLength(30);
    expect(body.days.at(-1)?.day).toBe("2026-11-02");
    expect(body.days.at(-1)?.start).toBe(Date.parse("2026-11-02T05:00:00Z"));
    expect(body.days.at(-2)?.start).toBe(Date.parse("2026-11-01T04:00:00Z"));
    const byDay = Object.fromEntries(
      body.days.map((day) => [day.day, day.bytes]),
    );
    expect(byDay["2026-10-31"]).toBe(bytesOf(rows[0]!.id));
    expect(byDay["2026-11-01"]).toBe(bytesOf(rows[1]!.id));
    expect(byDay["2026-11-02"]).toBe(0);
    expect(body.before).toBe(0);
    // the same rows in UTC land a day later
    const utc = await storage(chat, "UTC");
    const utcByDay = Object.fromEntries(
      utc.days.map((day) => [day.day, day.bytes]),
    );
    expect(utcByDay["2026-11-01"]).toBe(bytesOf(rows[0]!.id));
    expect(utcByDay["2026-11-02"]).toBe(bytesOf(rows[1]!.id));
  });

  test("puts a replaced file's live bytes on the day it was written", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-06-10T12:00:00Z");
    await relogin(chat);
    const projectId = await team(chat, "docs");
    const base = `/api/projects/${projectId}/knowledge`;
    const created = await chat.member.call("POST", base, {
      body: { name: "notes.md", text: "one" },
    });
    expect(created.status).toBe(201);
    const { file } = await created.json();
    chat.app.now.value = Date.parse("2026-06-15T12:00:00Z");
    const replaced = await chat.member.call("PUT", `${base}/files/${file.id}`, {
      body: { text: "one and two", revision: file.revision },
    });
    expect(replaced.status).toBe(200);
    const body = await storage(chat);
    const byDay = Object.fromEntries(
      body.days.map((day) => [day.day, day.bytes]),
    );
    // the first version on its day; the live file and its second
    // version on the day of the write
    expect(byDay["2026-06-10"]).toBe(3);
    expect(byDay["2026-06-15"]).toBe(11 + 11);
  });

  test("counts the days before the window", async () => {
    const chat = await chatApp();
    chat.app.now.value = Date.parse("2026-06-15T12:00:00Z");
    await relogin(chat);
    const sessionId = await settledChat(chat);
    chat.app.db
      .query("update messages set created_at = ? where session_id = ?")
      .run(Date.parse("2026-05-01T12:00:00Z"), sessionId);
    const body = await storage(chat);
    expect(body.before).toBe(messageBytes(chat, sessionId));
    expect(body.days.every((day) => day.bytes === 0)).toBe(true);
  });

  test("never names a personal project, its chats or its tasks", async () => {
    const chat = await chatApp();
    const sessionId = await settledChat(chat);
    const automation = await createAutomation(chat, {
      name: "secret-task",
    });
    const { sessionId: runId, main } = await startRun(chat, automation.id);
    main.reply("done");
    await settleRun(chat, runId);
    const text = JSON.stringify(await storage(chat));
    for (const secret of [
      chat.projectId,
      sessionId,
      runId,
      automation.id,
      "hello there",
      "secret-task",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"owner":"casey"');
  });

  test("refuses a bad or missing zone", async () => {
    const chat = await chatApp();
    for (const query of ["", "?tz=", "?tz=Mars%2FOlympus", "?tz=UTC&x=1"]) {
      const res = await chat.admin.call("GET", `/api/admin/storage${query}`);
      expect(res.status, query).toBe(400);
    }
  });
});
