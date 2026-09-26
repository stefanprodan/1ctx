// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  parseFeedCursor,
  SessionStore,
  type UsagePort,
} from "../../../src/server/sessions/index.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type { SessionStatus } from "../../../src/shared/words.ts";
import { memoryDb } from "../../helpers/db.ts";

const noUsage: UsagePort = {
  latest: () => null,
  latestFor: () => new Map(),
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
  const automation = (id: string, projectId: string, name: string) =>
    db
      .query(
        `insert into automations (id, project_id, owner_id, agent_id, name,
           instructions, schedule, tz, retention_days, next_at, created_at,
           updated_at)
         values (?, ?, 'u', 'a', ?, 'go', '0 * * * *', 'UTC', 30, 1, 0, 0)`,
      )
      .run(id, projectId, name);
  automation("digest", "p", "digest");
  automation("spend", "p", "spend");
  automation("audit", "t", "audit");
  const store = new SessionStore(db, noUsage, {
    drop() {},
    held: () => new Set(),
  });
  const chat = (now: number, title = "chat", projectId = "p") =>
    store.create({
      projectId,
      ownerId: "u",
      agentId: "a",
      title,
      status: "done",
      now,
    }).id;
  const run = (
    automationId: string,
    now: number,
    status: SessionStatus = "done",
    projectId = automationId === "audit" ? "t" : "p",
  ) =>
    store.create({
      projectId,
      ownerId: "u",
      agentId: "a",
      title: automationId,
      status,
      now,
      origin: "automation",
      automationId,
    }).id;
  return { db, store, chat, run };
}

const ids = (rows: StreamRow[]) => rows.map((row) => row.session.id);
const counts = (rows: StreamRow[]) => rows.map((row) => row.runs);

describe("runs grouped in All", () => {
  test("list each automation once, as its newest run, with its count", () => {
    const { store, chat, run } = seeded();
    const digest = Array.from({ length: 12 }, (_, i) => run("digest", 10 + i));
    const spend = Array.from({ length: 5 }, (_, i) => run("spend", 40 + i));
    const audit = Array.from({ length: 3 }, (_, i) => run("audit", 5 + i));
    const early = chat(1);
    const late = chat(100);
    const all = store.list(["p", "t"], "");
    expect(ids(all.rows)).toEqual([
      late,
      spend.at(-1)!,
      digest.at(-1)!,
      audit.at(-1)!,
      early,
    ]);
    expect(counts(all.rows)).toEqual([null, 5, 12, 3, null]);
    expect(all.next).toBeNull();
  });

  test("put a running automation first, where its run sorts", () => {
    const { store, chat, run } = seeded();
    run("digest", 10);
    const running = run("digest", 20, "running");
    const newer = chat(100);
    const rows = store.list(["p"], "").rows;
    expect(ids(rows)).toEqual([running, newer]);
    expect(rows[0]!.runs).toBe(2);
  });

  test("list a gone automation's runs one by one", () => {
    const { db, store, run } = seeded();
    const kept = run("spend", 50);
    const orphans = [run("digest", 10), run("digest", 20)];
    db.query("delete from automations where id = 'digest'").run();
    const rows = store.list(["p"], "").rows;
    expect(ids(rows)).toEqual([kept, orphans[1]!, orphans[0]!]);
    expect(counts(rows)).toEqual([1, null, null]);
  });

  test("leave Chats and Tasks as they were", () => {
    const { store, chat, run } = seeded();
    const runs = [run("digest", 10), run("digest", 20), run("spend", 30)];
    const chats = [chat(5), chat(6)];
    const tasks = store.list(["p"], "", "automation").rows;
    expect(ids(tasks)).toEqual([...runs].reverse());
    expect(counts(tasks)).toEqual([null, null, null]);
    expect(ids(store.list(["p"], "", "chat").rows)).toEqual(
      [...chats].reverse(),
    );
  });

  test("group a search by the newest run that holds it", () => {
    const { db, store, chat, run } = seeded();
    run("digest", 10);
    const newer = run("digest", 20);
    const renamed = run("digest", 30);
    db.query("update sessions set title = 'daily' where id = ?").run(renamed);
    const found = chat(15, "digest notes");
    const rows = store.list(["p"], "DIGEST").rows;
    expect(ids(rows)).toEqual([newer, found]);
    expect(counts(rows)).toEqual([3, null]);
    expect(ids(store.list(["p"], "daily").rows)).toEqual([renamed]);
    expect(ids(store.list(["p"], "nothing").rows)).toEqual([]);
  });

  test("keep an automation out of a project the caller does not see", () => {
    const { store, run } = seeded();
    run("audit", 10);
    const mine = run("digest", 5);
    expect(ids(store.list(["p"], "").rows)).toEqual([mine]);
  });

  test("page over the lines with no repeat and no gap", () => {
    const { store, chat, run } = seeded();
    const chats = Array.from({ length: 7 }, (_, i) => chat(Math.floor(i / 2)));
    const digest = Array.from({ length: 9 }, (_, i) => run("digest", i));
    const spend = run("spend", 3);
    run("audit", 2);
    const all = ids(store.list(["p"], "", null, null, 1000).rows);
    expect(all).toHaveLength(9);
    expect(all).toContain(digest.at(-1)!);
    expect(all).toContain(spend);
    const got: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = store.list(
        ["p"],
        "",
        null,
        before === null ? null : parseFeedCursor(before),
        2,
      );
      got.push(...ids(page.rows));
      if (page.next === null) break;
      before = page.next;
    }
    expect(got).toEqual(all);
    expect(chats.every((id) => got.includes(id))).toBe(true);
    // a new run moves the line above the cursor: no later page repeats it
    const first = store.list(["p"], "", null, null, 2);
    const moved = run("digest", 500, "running");
    const rest = store.list(["p"], "", null, parseFeedCursor(first.next!), 50);
    expect(ids(rest.rows)).not.toContain(moved);
    expect(ids(rest.rows)).not.toContain(digest.at(-1)!);
  });
});
