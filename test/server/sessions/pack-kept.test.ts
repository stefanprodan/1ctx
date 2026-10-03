// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The kept files job: which sessions it packs, its batches and pass
// budget, where a pass resumes, and how a stop ends it.

import { describe, expect, test } from "bun:test";
import { writeKeptFiles } from "../../../src/server/bash/index.ts";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  KEPT_BATCH_BYTES,
  type KeptPackDeps,
  keptPacker,
} from "../../../src/server/sessions/pack-kept.ts";
import { collectLogs } from "../../helpers/app.ts";
import { settleRun } from "../../helpers/automations.ts";
import { type ChatApp, chatApp, startChat } from "../../helpers/chat.ts";
import { type Setup, setup } from "../knowledge/helpers.ts";

const KEPT = DEFAULT_LIMITS.archivedDeleteDays;
const SIZE = 2048;

let rows = 0;

// a tool row of the session holding the kept files, one folder each
function keep(s: Setup, sessionId: string, files = 1, size = SIZE): string {
  rows++;
  const { provider_id } = s.db
    .query<{ provider_id: string }, [string]>(
      "select provider_id from agents where id = ?",
    )
    .get(s.agent.id)!;
  const send = `send${rows}`;
  const message = `msg${rows}`;
  s.db
    .query(
      `insert into sends (id, session_id, kind, user_id, agent_id, provider_id,
         provider_name, model, status, first_message_id, started_at)
       values (?, ?, 'chat', ?, ?, ?, 'p', 'm', 'done', ?, 0)`,
    )
    .run(send, sessionId, s.author.id, s.agent.id, provider_id, message);
  s.db
    .query(
      `insert into messages (id, session_id, seq, kind, send_id, round, content,
         status, created_at, tool_call_id, tool_name)
       values (?, ?, ?, 'tool', ?, 1, '', 'done', 0, 'c', 'mcp')`,
    )
    .run(message, sessionId, rows, send);
  writeKeptFiles(
    s.db,
    message,
    Array.from({ length: files }, (_, i) => ({
      folder: i + 1,
      dir: `${String(i + 1).padStart(4, "0")}-get`,
      name: "result.txt",
      text: String(i % 10).repeat(size),
      data: null,
      bytes: size,
    })),
  );
  return message;
}

const packedOf = (s: Setup, sessionId: string): number[] =>
  s.db
    .query<{ packed: number }, [string]>(
      `select packed from mcp_kept_files where session_id = ?
       order by folder, position`,
    )
    .all(sessionId)
    .map((row) => row.packed);

// a session made into the state named, its last activity days ago
function session(
  s: Setup,
  state: {
    origin?: "chat" | "automation";
    status?: "done" | "running";
    archivedDays?: number;
    activeDays?: number;
    automationId?: string | null;
  },
): string {
  const id = s.makeSession().id;
  const at = (days: number) => s.now.value - days * DAY_MS;
  s.db
    .query(
      `update sessions set origin = ?, status = ?, archived_at = ?,
         archived_reason = ?, last_activity_at = ?, automation_id = ?
       where id = ?`,
    )
    .run(
      state.origin ?? "chat",
      state.status ?? "done",
      state.archivedDays === undefined ? null : at(state.archivedDays),
      state.archivedDays === undefined ? null : "manual",
      at(state.activeDays ?? state.archivedDays ?? 0),
      state.automationId ?? null,
      id,
    );
  return id;
}

function automation(s: Setup, retentionDays: number): string {
  const id = `auto${++rows}`;
  s.db
    .query(
      `insert into automations (id, project_id, owner_id, agent_id, name,
         instructions, schedule, tz, retention_days, next_at, created_at,
         updated_at)
       values (?, ?, ?, ?, ?, 'check', '0 9 * * *', 'UTC', ?, 1, 0, 0)`,
    )
    .run(id, s.projectId, s.author.id, s.agent.id, id, retentionDays);
  return id;
}

function packer(s: Setup, options: Partial<KeptPackDeps> = {}) {
  return keptPacker({
    db: s.db,
    clock: () => s.now.value,
    log: silent,
    limits: { current: () => ({ archivedDeleteDays: KEPT }) },
    ...options,
  });
}

describe("the kept files job", () => {
  test("packs archived chats and ended runs, never one that can send or is due to go", async () => {
    const s = setup();
    try {
      const daily = automation(s, 30);
      const packs = {
        archived: session(s, { archivedDays: 1 }),
        run: session(s, {
          origin: "automation",
          automationId: daily,
          activeDays: 29,
        }),
        orphan: session(s, { origin: "automation", activeDays: KEPT - 1 }),
      };
      const skips = {
        live: session(s, { activeDays: 100 }),
        running: session(s, { archivedDays: 1, status: "running" }),
        runningRun: session(s, {
          origin: "automation",
          automationId: daily,
          status: "running",
        }),
        oldArchived: session(s, { archivedDays: KEPT + 1 }),
        expiredRun: session(s, {
          origin: "automation",
          automationId: daily,
          activeDays: 31,
        }),
        oldOrphan: session(s, { origin: "automation", activeDays: KEPT + 1 }),
      };
      for (const id of [...Object.values(packs), ...Object.values(skips)]) {
        keep(s, id);
      }
      const { events, logFactory } = collectLogs();
      const pass = await packer(s, { log: logFactory("sessions") }).pass();
      expect(pass).toMatchObject({ batches: 1, files: 3, packed: 3 });
      for (const id of Object.values(packs))
        expect(packedOf(s, id)).toEqual([2]);
      for (const id of Object.values(skips))
        expect(packedOf(s, id)).toEqual([0]);
      // no session that can still send holds a packed file
      expect(
        s.db
          .query<{ n: number }, []>(
            `select count(*) as n from mcp_kept_files k
             join sessions on sessions.id = k.session_id
             where k.packed > 0 and (sessions.status = 'running'
               or (sessions.origin = 'chat' and sessions.archived_at is null))`,
          )
          .get()!.n,
      ).toBe(0);
      expect(events).toEqual([
        {
          level: "info",
          area: "sessions",
          msg: "kept packed",
          fields: {
            batches: 1,
            files: 3,
            packed: 3,
            refused: 0,
            bytes_in: 3 * SIZE,
            bytes_out: pass.bytesOut,
            duration: expect.any(Number),
          },
        },
      ]);
      // nothing left: no batch and no line
      expect(await packer(s, { log: logFactory("sessions") }).pass()).toEqual(
        expect.objectContaining({ batches: 0, files: 0 }),
      );
      expect(events).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });

  test("a pass stops at its budget, oldest session first, and the next resumes", async () => {
    const s = setup();
    try {
      const newer = session(s, { archivedDays: 1 });
      const older = session(s, { archivedDays: 2 });
      keep(s, newer, 2);
      keep(s, older, 3);
      const job = packer(s, { batchBytes: 2 * SIZE, passBytes: 3 * SIZE });
      expect(await job.pass()).toMatchObject({
        batches: 2,
        files: 3,
        bytesIn: 3 * SIZE,
      });
      expect(packedOf(s, older)).toEqual([2, 2, 2]);
      expect(packedOf(s, newer)).toEqual([0, 0]);
      expect(await job.pass()).toMatchObject({ batches: 1, files: 2 });
      expect(packedOf(s, newer)).toEqual([2, 2]);
    } finally {
      s.db.close();
    }
  });

  test("a batch rechecks its sessions, so one that runs again is left", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id, 3);
      const job = packer(s, { batchBytes: SIZE });
      const pass = job.pass();
      // the first batch ran in the call; the next waits on a timer
      s.db.query("update sessions set status = 'running' where id = ?").run(id);
      expect(await pass).toMatchObject({ batches: 1, files: 1 });
      expect(packedOf(s, id)).toEqual([2, 0, 0]);
    } finally {
      s.db.close();
    }
  });

  test("a stop ends the pass before its next batch and keeps it stopped", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id, 4);
      const job = packer(s, { batchBytes: SIZE });
      const pass = job.pass();
      // one pass at a time: a second call joins the first
      expect(job.pass()).toBe(pass);
      await job.stop();
      expect(await pass).toMatchObject({ batches: 1, files: 1 });
      expect(packedOf(s, id)).toEqual([2, 0, 0, 0]);
      expect(await job.pass()).toMatchObject({ batches: 0 });
      expect(packedOf(s, id)).toEqual([2, 0, 0, 0]);
    } finally {
      s.db.close();
    }
  });

  test("a failing batch ends the pass with a warning", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id);
      const { events, logFactory } = collectLogs();
      const job = packer(s, {
        log: logFactory("sessions"),
        limits: {
          current: () => {
            throw new Error("limits unreadable");
          },
        },
      });
      expect(await job.pass()).toMatchObject({ files: 0 });
      expect(events.map((event) => [event.level, event.msg])).toEqual([
        ["warn", "kept packing failed"],
      ]);
    } finally {
      s.db.close();
    }
  });
});

describe("the kept files job in the app", () => {
  async function archivedChat(chat: ChatApp): Promise<string> {
    const started = await startChat(chat, "hello");
    started.script.reply("the answer");
    await settleRun(chat, started.sessionId);
    chat.app.db
      .query(
        "update sessions set archived_at = ?, archived_reason = 'manual' where id = ?",
      )
      .run(chat.app.now.value, started.sessionId);
    return started.sessionId;
  }

  test("a shutdown during a pass starts no further batch", async () => {
    const chat = await chatApp();
    const id = await archivedChat(chat);
    const messageId = chat.app.db
      .query<{ id: string }, [string]>(
        "select id from messages where session_id = ? limit 1",
      )
      .get(id)!.id;
    const size = KEPT_BATCH_BYTES / 4;
    writeKeptFiles(
      chat.app.db,
      messageId,
      Array.from({ length: 6 }, (_, i) => ({
        folder: i + 1,
        dir: `${String(i + 1).padStart(4, "0")}-get`,
        name: "result.txt",
        text: "y".repeat(size),
        data: null,
        bytes: size,
      })),
    );
    const pass = chat.app.packKept();
    await chat.app.shutdown();
    expect(await pass).toMatchObject({ batches: 1, files: 4 });
    expect(
      chat.app.db
        .query<{ packed: number }, [string]>(
          "select packed from mcp_kept_files where session_id = ? order by folder",
        )
        .all(id)
        .map((row) => row.packed),
    ).toEqual([2, 2, 2, 2, 0, 0]);
  });

  test("a live chat's files are never packed", async () => {
    const chat = await chatApp();
    const started = await startChat(chat, "hello");
    started.script.reply("the answer");
    await settleRun(chat, started.sessionId);
    const messageId = chat.app.db
      .query<{ id: string }, [string]>(
        "select id from messages where session_id = ? limit 1",
      )
      .get(started.sessionId)!.id;
    writeKeptFiles(chat.app.db, messageId, [
      {
        folder: 1,
        dir: "0001-get",
        name: "result.txt",
        text: "z".repeat(SIZE),
        data: null,
        bytes: SIZE,
      },
    ]);
    expect(await chat.app.packKept()).toMatchObject({ files: 0 });
    await chat.app.shutdown();
  });

  test("a fork of a packed chat gets raw files; a broken frame fails it", async () => {
    const { events, logFactory } = collectLogs();
    const chat = await chatApp({ logFactory });
    const id = await archivedChat(chat);
    const { db } = chat.app;
    const answer = db
      .query<{ id: string }, [string]>(
        "select id from messages where session_id = ? and slot = 'answer'",
      )
      .get(id)!.id;
    const text = "kind: Pod\nmetadata:\n  name: résumé\n".repeat(100);
    const data = new Uint8Array(3000).map((_, i) => i % 7);
    writeKeptFiles(db, answer, [
      {
        folder: 1,
        dir: "0001-get",
        name: "result.txt",
        text,
        data: null,
        bytes: Buffer.byteLength(text),
      },
      {
        folder: 1,
        dir: "0001-get",
        name: "a.bin",
        text: null,
        data,
        bytes: data.byteLength,
      },
    ]);
    const files = (sessionId: string) =>
      db
        .query<
          {
            name: string;
            text: string | null;
            data: Uint8Array | null;
            packed: number;
          },
          [string]
        >(
          `select name, text, data, packed from mcp_kept_files
           where session_id = ? order by position`,
        )
        .all(sessionId);
    const before = files(id);
    expect(await chat.app.packKept()).toMatchObject({ packed: 2 });
    expect(files(id).map((file) => file.packed)).toEqual([2, 1]);
    const fork = () =>
      chat.member.call("POST", `/api/sessions/${id}/fork`, {
        body: { messageId: answer, agentId: chat.agentId },
      });
    const res = await fork();
    expect(res.status).toBe(201);
    const forked = (await res.json()).session.id as string;
    expect(files(forked)).toEqual(before);

    db.query(
      "update mcp_kept_files set data = x'00010203' where session_id = ? and position = 0",
    ).run(id);
    expect((await fork()).status).toBe(500);
    // the fork's transaction left nothing behind
    expect(
      db
        .query<{ n: number }, [string]>(
          "select count(*) as n from sessions where forked_from_session_id = ?",
        )
        .get(id)!.n,
    ).toBe(1);
    const failed = events.filter((event) => event.level === "error");
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).toContain(
      "a packed kept file did not decode",
    );
    await chat.app.shutdown();
  });
});
