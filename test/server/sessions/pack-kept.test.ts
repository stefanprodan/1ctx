// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The kept files job: which sessions it packs, its batches and pass
// budget, where a pass resumes, and how a stop ends it.

import { describe, expect, spyOn, test } from "bun:test";
import { writeKeptFiles } from "../../../src/server/bash/index.ts";
import { KEPT_PENDING, KEPT_WALK } from "../../../src/server/bash/kept.ts";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  KEPT_BATCH_BYTES,
  KEPT_PASS_MS,
  KEPT_STILL,
  type KeptPackDeps,
  keptPacker,
} from "../../../src/server/sessions/pack-kept.ts";
import { sweepChats } from "../../../src/server/sessions/sweep.ts";
import { collectLogs } from "../../helpers/app.ts";
import { settleRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  setLimits,
  startChat,
} from "../../helpers/chat.ts";
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
        expect(packedOf(s, id)).toEqual([1]);
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
            skipped: 0,
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

  test("a pass stops at its budget and the next resumes where the walk left", async () => {
    const s = setup();
    try {
      const first = session(s, { archivedDays: 1 });
      const second = session(s, { archivedDays: 2 });
      keep(s, first, 2);
      keep(s, second, 3);
      const packedAll = () =>
        [...packedOf(s, first), ...packedOf(s, second)].filter((p) => p === 1)
          .length;
      const job = packer(s, { batchBytes: 2 * SIZE, passBytes: 3 * SIZE });
      expect(await job.pass()).toMatchObject({
        batches: 2,
        files: 3,
        packed: 3,
        bytesIn: 3 * SIZE,
      });
      expect(packedAll()).toBe(3);
      expect(await job.pass()).toMatchObject({ batches: 1, files: 2 });
      expect(packedAll()).toBe(5);
    } finally {
      s.db.close();
    }
  });

  test("a batch takes one file past its budget alone", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id, 1, 3 * SIZE);
      keep(s, id, 2);
      const job = packer(s, { batchBytes: SIZE });
      expect(await job.pass()).toMatchObject({
        batches: 3,
        files: 3,
        packed: 3,
        bytesIn: 5 * SIZE,
      });
    } finally {
      s.db.close();
    }
  });

  test("the walk goes past a chunk of sessions that cannot be packed", async () => {
    const s = setup();
    try {
      // more live chats than one step of the walk reads
      for (let i = 0; i < 300; i++) keep(s, session(s, {}), 1, 1024);
      const id = session(s, { archivedDays: 1 });
      keep(s, id);
      expect(await packer(s).pass()).toMatchObject({ files: 1, packed: 1 });
      expect(packedOf(s, id)).toEqual([1]);
    } finally {
      s.db.close();
    }
  });

  test("a batch rechecks its sessions at its write, so one that runs again is left", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id, 3);
      const job = packer(s, { batchBytes: SIZE });
      const pass = job.pass();
      // the first batch read in the call and waits on its compression
      s.db.query("update sessions set status = 'running' where id = ?").run(id);
      expect(await pass).toMatchObject({
        batches: 1,
        files: 1,
        packed: 0,
        skipped: 1,
      });
      expect(packedOf(s, id)).toEqual([0, 0, 0]);
    } finally {
      s.db.close();
    }
  });

  test("a session deleted while its batch compresses is skipped", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id, 2);
      const other = session(s, { archivedDays: 1 });
      keep(s, other);
      const { events, logFactory } = collectLogs();
      const job = packer(s, { log: logFactory("sessions") });
      const pass = job.pass();
      s.db.query("delete from sessions where id = ?").run(id);
      const done = await pass;
      expect(done).toMatchObject({
        batches: 1,
        files: 3,
        packed: 1,
        skipped: 2,
      });
      expect(events.filter((event) => event.level === "warn")).toEqual([]);
      expect(packedOf(s, id)).toEqual([]);
      expect(packedOf(s, other)).toEqual([1]);
    } finally {
      s.db.close();
    }
  });

  test("a stop lets the running batch write and starts no other", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id, 4);
      const job = packer(s, { batchBytes: SIZE });
      const pass = job.pass();
      // one pass at a time: a second call joins the first
      expect(job.pass()).toBe(pass);
      await job.stop();
      expect(packedOf(s, id)).toEqual([1, 0, 0, 0]);
      expect(await pass).toMatchObject({ batches: 1, files: 1 });
      expect(await job.pass()).toMatchObject({ batches: 0 });
      expect(packedOf(s, id)).toEqual([1, 0, 0, 0]);
    } finally {
      s.db.close();
    }
  });

  test("a failing write rolls its batch back and the next pass packs", async () => {
    const s = setup();
    try {
      const id = session(s, { archivedDays: 1 });
      keep(s, id, 3);
      const before = s.db
        .query("select * from mcp_kept_files order by folder")
        .all();
      // the second write of a batch raises
      s.db.exec(`
        create trigger kept_fail before update on mcp_kept_files
        when (select count(*) from mcp_kept_files where packed <> 0) >= 1
        begin select raise(abort, 'kept write failed'); end;
      `);
      const { events, logFactory } = collectLogs();
      const job = packer(s, { log: logFactory("sessions") });
      expect(await job.pass()).toMatchObject({ files: 0, packed: 0 });
      expect(
        s.db.query("select * from mcp_kept_files order by folder").all(),
      ).toEqual(before);
      expect(events.map((event) => [event.level, event.msg])).toEqual([
        ["warn", "kept packing failed"],
      ]);
      s.db.exec("drop trigger kept_fail");
      expect(await job.pass()).toMatchObject({ files: 3, packed: 3 });
      expect(packedOf(s, id)).toEqual([1, 1, 1]);
    } finally {
      s.db.close();
    }
  });
});

describe("the kept files job at its edges", () => {
  test("a session exactly at its cut is packed and kept, one past it is neither", async () => {
    const s = setup();
    try {
      const now = s.now.value;
      const cut = now - KEPT * DAY_MS;
      const task = automation(s, 30);
      const taskCut = now - 30 * DAY_MS;
      const at = (
        fields: Parameters<typeof session>[1],
        column: "archived_at" | "last_activity_at",
        value: number,
      ) => {
        const id = session(s, fields);
        s.db
          .query(`update sessions set ${column} = ? where id = ?`)
          .run(value, id);
        keep(s, id);
        return id;
      };
      const chat = { archivedDays: 0 };
      const orphan = { origin: "automation" as const };
      const run = { origin: "automation" as const, automationId: task };
      const onCut = [
        at(chat, "archived_at", cut),
        at(orphan, "last_activity_at", cut),
        at(run, "last_activity_at", taskCut),
      ];
      const pastCut = [
        at(chat, "archived_at", cut - 1),
        at(orphan, "last_activity_at", cut - 1),
        at(run, "last_activity_at", taskCut - 1),
      ];
      expect(await packer(s).pass()).toMatchObject({ files: 3 });
      for (const id of onCut) expect(packedOf(s, id)).toEqual([1]);
      for (const id of pastCut) expect(packedOf(s, id)).toEqual([0]);

      // the deleters take exactly the ones the job left
      const expired = s.sessions.expiredRuns(now).map((row) => row.id);
      expect(expired).toEqual([pastCut[2]]);
      const swept = sweepChats(
        {
          db: s.db,
          store: s.sessions,
          scratch: { drop() {}, held: () => new Set() },
          log: silent,
        },
        now,
        {
          archiveIdleDays: DEFAULT_LIMITS.archiveIdleDays,
          archivedDeleteDays: KEPT,
        },
      );
      expect(swept).toMatchObject({ chats_deleted: 1, runs_deleted: 1 });
      for (const id of onCut) expect(s.sessions.byId(id)).not.toBeNull();
      expect(s.sessions.byId(pastCut[0]!)).toBeNull();
      expect(s.sessions.byId(pastCut[1]!)).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test.serial(
    "start runs a pass now and hourly on an unref'd timer, and not after stop",
    async () => {
      const s = setup();
      const every = spyOn(globalThis, "setInterval");
      try {
        const id = session(s, { archivedDays: 1 });
        keep(s, id);
        const job = packer(s);
        job.start();
        await job.pass();
        expect(packedOf(s, id)).toEqual([1]);
        const hourly = every.mock.calls.findIndex(
          ([, ms]) => ms === KEPT_PASS_MS,
        );
        expect(hourly).toBeGreaterThanOrEqual(0);
        const timer = every.mock.results[hourly]!.value as ReturnType<
          typeof setInterval
        >;
        expect(timer.hasRef()).toBe(false);
        job.start();
        expect(
          every.mock.calls.filter(([, ms]) => ms === KEPT_PASS_MS),
        ).toHaveLength(1);

        await job.stop();
        const late = session(s, { archivedDays: 1 });
        keep(s, late);
        job.start();
        expect(
          every.mock.calls.filter(([, ms]) => ms === KEPT_PASS_MS),
        ).toHaveLength(1);
        await Bun.sleep(5);
        expect(packedOf(s, late)).toEqual([0]);
      } finally {
        every.mockRestore();
        s.db.close();
      }
    },
  );

  test("the job's queries read the candidate index", () => {
    const s = setup();
    try {
      const plan = (sql: string, ...args: (string | number)[]) =>
        s.db
          .query<{ detail: string }, (string | number)[]>(
            `explain query plan ${sql}`,
          )
          .all(...args)
          .map((row) => row.detail)
          .join(" | ");
      expect(plan(KEPT_PENDING, "x")).toContain(
        "COVERING INDEX mcp_kept_files_packable (session_id=?)",
      );
      const walk = plan(KEPT_WALK, "", 256);
      expect(walk).toBe(
        "SEARCH mcp_kept_files USING COVERING INDEX mcp_kept_files_packable (session_id>?)",
      );
      expect(plan(KEPT_STILL, 0, 0, "x")).toContain(
        "SEARCH sessions USING INDEX sqlite_autoindex_sessions_1 (id=?)",
      );
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
    ).toEqual([1, 1, 1, 1, 0, 0]);
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
        .query<{ name: string; bytes: Uint8Array; packed: number }, [string]>(
          `select name, coalesce(cast(text as blob), data) as bytes, packed
           from mcp_kept_files where session_id = ? order by position`,
        )
        .all(sessionId);
    const before = files(id);
    expect(await chat.app.packKept()).toMatchObject({ packed: 2 });
    expect(files(id).map((file) => file.packed)).toEqual([1, 1]);
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

  test("a refused start on a packed chat trims nothing", async () => {
    const chat = await chatApp();
    // a start would drop the first folder to fit ten files
    await setLimits(chat, { mcpKeptFiles: 10 });
    const id = await archivedChat(chat);
    const messageId = chat.app.db
      .query<{ id: string }, [string]>(
        "select id from messages where session_id = ? limit 1",
      )
      .get(id)!.id;
    writeKeptFiles(
      chat.app.db,
      messageId,
      Array.from({ length: 11 }, (_, i) => ({
        folder: i < 10 ? 1 : 2,
        dir: i < 10 ? "0001-get" : "0002-get",
        name: `part-${i}.txt`,
        text: "k".repeat(SIZE),
        data: null,
        bytes: SIZE,
      })),
    );
    expect(await chat.app.packKept()).toMatchObject({ packed: 11 });
    const rows = () =>
      chat.app.db
        .query("select * from mcp_kept_files where session_id = ?")
        .all(id);
    const before = rows();
    const refused = await chat.member.call(
      "POST",
      `/api/sessions/${id}/messages`,
      { body: { message: "more" } },
    );
    expect(refused.status).toBe(409);
    expect(rows()).toEqual(before);
    await chat.app.shutdown();
  });
});
