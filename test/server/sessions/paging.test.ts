// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { Db } from "../../../src/server/db/index.ts";
import {
  parseFeedCursor,
  parseRunsCursor,
  SessionStore,
  STREAM_LIMIT,
  type UsagePort,
} from "../../../src/server/sessions/index.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type { SessionStatus } from "../../../src/shared/words.ts";
import { memoryDb } from "../../helpers/db.ts";

const noUsage: UsagePort = {
  latest: () => null,
  latestFor: () => new Map(),
  deleteSession: () => 0,
};

function seeded() {
  const db = memoryDb();
  db.query(
    "insert into users (id, username, full_name, email, role, password_hash, created_at) values ('u', 'user', 'User', 'user@example.com', 'member', 'x', 0)",
  ).run();
  db.query(
    "insert into projects (id, kind, name, owner_id, created_at) values ('p', 'personal', 'personal', 'u', 0), ('t', 'team', 'team-one', 'u', 0)",
  ).run();
  db.query(
    "insert into providers (id, name, wire, base_url, created_at) values ('pr', 'prov', 'openai-compatible', 'http://x', 0)",
  ).run();
  db.query(
    "insert into agents (id, name, provider_id, model, model_name, created_at) values ('a', 'agent', 'pr', 'm', 'M', 0)",
  ).run();
  db.query(
    `insert into automations (id, project_id, owner_id, agent_id, name,
       instructions, schedule, tz, retention_days, next_at, created_at,
       updated_at)
     values ('au', 'p', 'u', 'a', 'digest', 'go', '0 * * * *', 'UTC', 30, 1, 0, 0)`,
  ).run();
  const store = new SessionStore(db, noUsage);
  const add = (
    fields: Partial<{
      projectId: string;
      status: SessionStatus;
      now: number;
      title: string;
      run: boolean;
    }> = {},
  ) =>
    store.create({
      projectId: fields.projectId ?? "p",
      ownerId: "u",
      agentId: "a",
      title: fields.title ?? "chat",
      status: fields.status ?? "done",
      now: fields.now ?? 0,
      ...(fields.run
        ? { origin: "automation" as const, automationId: "au" }
        : {}),
    }).id;
  return { db, store, add };
}

const ids = (rows: StreamRow[]) => rows.map((row) => row.session.id);

// every page of a listing, following next until it is null
function pages(
  read: (before: string | null) => { rows: StreamRow[]; next: string | null },
): string[][] {
  const out: string[][] = [];
  let before: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page = read(before);
    out.push(ids(page.rows));
    if (page.next === null) return out;
    before = page.next;
  }
  throw new Error("pages never ended");
}

const touch = (db: Db, id: string, status: SessionStatus, at: number) =>
  db
    .query("update sessions set status = ?, last_activity_at = ? where id = ?")
    .run(status, at, id);

describe("the stream's pages", () => {
  test("page 120 rows with tied activity into 50, 50 and 20", () => {
    const { store, add } = seeded();
    for (let i = 0; i < 120; i++) add({ now: Math.floor(i / 4) });
    const all = ids(store.list(["p"], "", null, null, 1000).rows);
    const got = pages((before) =>
      store.list(
        ["p"],
        "",
        null,
        before === null ? null : parseFeedCursor(before),
      ),
    );
    expect(STREAM_LIMIT).toBe(50);
    expect(got.map((page) => page.length)).toEqual([50, 50, 20]);
    expect(got.flat()).toEqual(all);
    expect(new Set(got.flat()).size).toBe(120);
  });

  test("carry the rank, so running rows page past the first page", () => {
    const { store, add } = seeded();
    for (let i = 0; i < 32; i++) add({ status: "running", now: i % 3 });
    for (let i = 0; i < 60; i++) add({ now: 100 + (i % 7) });
    const all = ids(store.list(["p"], "", null, null, 1000).rows);
    const first = store.list(["p"], "");
    expect(first.rows.map((row) => row.session.status)).toEqual([
      ...Array(32).fill("running"),
      ...Array(18).fill("done"),
    ]);
    expect(first.next?.startsWith("0.")).toBe(true);
    const small = pages((before) =>
      store.list(
        ["p"],
        "",
        null,
        before === null ? null : parseFeedCursor(before),
        20,
      ),
    );
    expect(small.map((page) => page.length)).toEqual([20, 20, 20, 20, 12]);
    expect(small.flat()).toEqual(all);
  });

  test("list a running row that finishes between pages", () => {
    const { db, store, add } = seeded();
    const running = Array.from({ length: 5 }, (_, i) =>
      add({ status: "running", now: 50 - i }),
    );
    const finished = Array.from({ length: 10 }, (_, i) => add({ now: 30 - i }));
    const first = store.list(["p"], "", null, null, 3);
    expect(ids(first.rows)).toEqual(running.slice(0, 3));
    expect(first.next?.startsWith("1.")).toBe(true);
    touch(db, running[3]!, "done", 1000);
    const second = store.list(["p"], "", null, parseFeedCursor(first.next!), 3);
    expect(ids(second.rows)).toEqual([running[4]!, running[3]!, finished[0]!]);
  });

  test("leave a row that jumps above the cursor to the first page", () => {
    const { db, store, add } = seeded();
    const made = Array.from({ length: 60 }, (_, i) => add({ now: 100 - i }));
    const first = store.list(["p"], "");
    const moved = made[55]!;
    touch(db, moved, "running", 1000);
    const second = store.list(["p"], "", null, parseFeedCursor(first.next!));
    expect(ids(second.rows)).not.toContain(moved);
    expect(ids(second.rows)).toEqual(
      made.slice(50).filter((id) => id !== moved),
    );
    expect(ids(store.list(["p"], "").rows)[0]).toBe(moved);
  });

  test("answer next null for exactly a page", () => {
    const { store, add } = seeded();
    for (let i = 0; i < 50; i++) add({ now: i });
    const page = store.list(["p"], "");
    expect(page.rows).toHaveLength(50);
    expect(page.next).toBeNull();
    add({ now: 99 });
    expect(store.list(["p"], "").next).not.toBeNull();
  });

  test("page from a cursor whose row is gone", () => {
    const { db, store, add } = seeded();
    const made = Array.from({ length: 60 }, (_, i) => add({ now: 100 - i }));
    const first = store.list(["p"], "");
    db.query("delete from sessions where id = ?").run(made[49]!);
    const second = store.list(["p"], "", null, parseFeedCursor(first.next!));
    expect(ids(second.rows)).toEqual(made.slice(50));
  });

  test("keep the filters and the search across pages", () => {
    const { store, add } = seeded();
    const found: string[] = [];
    const runs: string[] = [];
    for (let i = 0; i < 80; i++) {
      const id = add({ now: 200 - i, title: i % 2 === 0 ? "Deploy" : "chat" });
      if (i % 2 === 0) found.push(id);
    }
    for (let i = 0; i < 55; i++) runs.push(add({ now: 300 - i, run: true }));
    const cursor = (before: string | null) =>
      before === null ? null : parseFeedCursor(before);
    const searched = pages((before) =>
      store.list(["p"], "depl", null, cursor(before)),
    );
    expect(searched.map((page) => page.length)).toEqual([40]);
    expect(searched.flat()).toEqual(found);
    const tasks = pages((before) =>
      store.list(["p"], "", "automation", cursor(before)),
    );
    expect(tasks.map((page) => page.length)).toEqual([50, 5]);
    expect(tasks.flat()).toEqual(runs);
    const chats = pages((before) =>
      store.list(["p"], "", "chat", cursor(before)),
    );
    expect(chats.map((page) => page.length)).toEqual([50, 30]);
    const many = Array.from({ length: 30 }, (_, i) =>
      add({ now: 400 - i, title: "Deploy again" }),
    );
    const again = pages((before) =>
      store.list(["p"], "deploy", "chat", cursor(before)),
    );
    expect(again.map((page) => page.length)).toEqual([50, 20]);
    expect(again.flat()).toEqual([...many, ...found]);
  });

  test("page Home's projects together and one project alone", () => {
    const { store, add } = seeded();
    const personal: string[] = [];
    const team: string[] = [];
    for (let i = 0; i < 70; i++) {
      const projectId = i % 2 === 0 ? "p" : "t";
      const id = add({ projectId, now: 500 - i });
      (projectId === "p" ? personal : team).push(id);
    }
    const cursor = (before: string | null) =>
      before === null ? null : parseFeedCursor(before);
    const home = pages((before) =>
      store.list(["p", "t"], "", null, cursor(before)),
    );
    expect(home.map((page) => page.length)).toEqual([50, 20]);
    expect(new Set(home.flat())).toEqual(new Set([...personal, ...team]));
    const one = pages((before) => store.list(["t"], "", null, cursor(before)));
    expect(one.flat()).toEqual(team);
  });
});

describe("an automation's pages of runs", () => {
  test("page by activity then id, the running run first, with the tally", () => {
    const { db, store, add } = seeded();
    const made = Array.from({ length: 70 }, (_, i) =>
      add({ run: true, now: Math.floor(i / 3) }),
    );
    for (const id of made.slice(0, 10)) touch(db, id, "failed", 0);
    const running = add({ run: true, status: "running", now: 1000 });
    const all = ids(store.runs("au", null, null, 1000).rows);
    expect(all[0]).toBe(running);
    const tallies: unknown[] = [];
    const got = pages((before) => {
      const page = store.runs(
        "au",
        null,
        before === null ? null : parseRunsCursor(before),
      );
      tallies.push(page.tally);
      return page;
    });
    expect(got.map((page) => page.length)).toEqual([50, 21]);
    expect(got.flat()).toEqual(all);
    for (const tally of tallies) {
      expect(tally).toEqual({ running: 1, done: 60, failed: 10, stopped: 0 });
    }
    const failed = store.runs("au", "failed", null, 4);
    expect(failed.rows).toHaveLength(4);
    const rest = store.runs("au", "failed", parseRunsCursor(failed.next!));
    expect(rest.next).toBeNull();
    expect(new Set([...ids(failed.rows), ...ids(rest.rows)])).toEqual(
      new Set(made.slice(0, 10)),
    );
  });
});
