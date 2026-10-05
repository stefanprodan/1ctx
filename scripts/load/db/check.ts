// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a built database holds, and the app's own reads over it: migrate
// is a no-op, the feed and its rows for an admin and two members, the
// envelopes of the sessions that matter, a chat's rows, and the sweeps'
// candidates as the next pass would find them.

import { Database } from "bun:sqlite";
import { migrate } from "../../../src/server/db/index.ts";
import { ProjectStore } from "../../../src/server/projects/store.ts";
import { parseFeedCursor } from "../../../src/server/sessions/cursor.ts";
import { envelopeRow } from "../../../src/server/sessions/feed.ts";
import { feedRead } from "../../../src/server/sessions/list.ts";
import { SessionStore } from "../../../src/server/sessions/store.ts";
import { UsageStore } from "../../../src/server/usage/store.ts";
import {
  ARCHIVE_IDLE_DAYS,
  ARCHIVED_DELETE_DAYS,
  DAY,
  NOW,
} from "./presets.ts";
import type { Timeline } from "./timeline.ts";

export function tableRows(db: Database) {
  const tables = db
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
    .map((x) => x.name);
  const count = (t: string) =>
    db.query<{ n: number }, []>(`select count(*) as n from "${t}"`).get()!.n;
  return Object.fromEntries(tables.map((t) => [t, count(t)]));
}

export function contents(db: Database, incident: string) {
  let objectBytes: Record<string, number> = {};
  try {
    objectBytes = Object.fromEntries(
      db
        .query<{ name: string; bytes: number }, []>(
          "select name, sum(pgsize) as bytes from dbstat group by name order by bytes desc",
        )
        .all()
        .map((x) => [x.name, x.bytes]),
    );
  } catch {
    objectBytes = { unavailable: 0 };
  }
  const sessions = Object.fromEntries(
    db
      .query<{ k: string; n: number }, []>(
        `select origin || ':' || status || ':' || coalesce(archived_reason, 'live') as k, count(*) as n from sessions group by 1 order by 1`,
      )
      .all()
      .map((x) => [x.k, x.n]),
  );
  const packed = db
    .query<{ n: number; raw: number; stored: number }, []>(
      "select count(*) as n, sum(packed_bytes) as raw, sum(length(packed)) as stored from messages where packed is not null",
    )
    .get()!;
  const inc = db
    .query<{ messages: number; bytes: number }, [string]>(
      "select count(*) as messages, sum(octet_length(content)) as bytes from messages where session_id = ?",
    )
    .get(incident)!;
  return {
    rows: tableRows(db),
    sessions,
    packed: {
      rows: packed.n,
      rawBytes: packed.raw,
      storedBytes: packed.stored,
      ratio: +(packed.stored / Math.max(1, packed.raw)).toFixed(3),
    },
    incident: { messages: inc.messages, bytes: inc.bytes },
    objectBytes,
  };
}

const timed = <X>(f: () => X): [X, number] => {
  const s = performance.now();
  const x = f();
  return [x, +(performance.now() - s).toFixed(1)];
};

export function validate(
  path: string,
  readers: Record<string, string | undefined>,
  tl: Timeline,
) {
  const v = new Database(path, { strict: true });
  v.exec("pragma foreign_keys = on");
  v.exec("pragma busy_timeout = 5000");
  const out: Record<string, unknown> = {};
  const fail: string[] = [];
  const ran = migrate(v);
  out.migrateRan = ran;
  if (ran.length > 0) fail.push("migrate was not a no-op");
  const usage = new UsageStore(v);
  const store = new SessionStore(v, usage, {
    drop() {},
    held: () => new Set<string>(),
  });
  const projects = new ProjectStore(v);
  for (const [label, name] of Object.entries(readers)) {
    if (!name) continue;
    const u = v
      .query<{ id: string; role: string }, [string]>(
        "select id, role from users where username = ?",
      )
      .get(name)!;
    const visible = projects
      .visibleFor(u.id, u.role === "admin")
      .map((p) => p.id);
    const [page, pageMs] = timed(() =>
      store.list({ projectIds: visible, q: "" }),
    );
    const cursor = page.next === null ? null : parseFeedCursor(page.next);
    const [second, secondMs] = timed(() =>
      store.list({ projectIds: visible, q: "", before: cursor }),
    );
    const [chats, chatsMs] = timed(() =>
      store.list({ projectIds: visible, q: "", origin: "chat" }),
    );
    const [runs, runsMs] = timed(() =>
      store.list({ projectIds: visible, q: "", origin: "automation" }),
    );
    const [search, searchMs] = timed(() =>
      store.list({ projectIds: visible, q: "incident" }),
    );
    const [miss, missMs] = timed(() =>
      feedRead(v, { projectIds: visible, q: "zzzz-no-such-title" }),
    );
    const running = (s: { session: { status: string } }) =>
      s.session.status === "running";
    const sorted = page.rows.every(
      (x, i, a) => i === 0 || running(a[i - 1]!) >= running(x),
    );
    out[label] = {
      projects: visible.length,
      rows: page.rows.length,
      running: page.rows.filter(running).length,
      next: page.next !== null,
      ms: pageMs,
      secondPage: { rows: second.rows.length, ms: secondMs },
      chats: { rows: chats.rows.length, ms: chatsMs },
      runs: { rows: runs.rows.length, ms: runsMs },
      search: { q: "incident", rows: search.rows.length, ms: searchMs },
      searchMiss: { rows: miss.length, ms: missMs },
      withSend: page.rows.filter((x) => x.send !== null).length,
      withLine: page.rows.filter((x) => x.last !== null).length,
    };
    // a short page is whole: a small build may hold fewer than a page
    if (!sorted || (page.next !== null && page.rows.length !== 50)) {
      fail.push(`${label} feed page is not a full sorted page`);
    }
    if (page.rows.some((x) => x.send === null)) {
      fail.push(`${label} feed row without a send`);
    }
  }
  const envelope = (id: string | null | undefined) => {
    if (!id) return null;
    const [row, t] = timed(() => envelopeRow(v, id));
    return {
      agent: row?.agent,
      send: row?.send?.status ?? null,
      last: row?.last?.author ?? null,
      automation: row?.automation?.name ?? null,
      ms: t,
    };
  };
  const s = tl.sample;
  const incident = envelope(tl.running.incident);
  out.envelopes = {
    incident,
    runningRun: envelope(tl.running.runs[0]),
    runningChat: envelope(tl.running.chats[0]),
    archivedChat: envelope(s.archivedChat),
    liveChat: envelope(s.liveChat),
    run: envelope(s.run),
    orphanRun: envelope(s.orphanRun),
  };
  if (incident?.send !== "running")
    fail.push("the incident has no running send");
  const [msgs, msgsMs] = timed(() => store.messages(tl.running.incident));
  out.incidentMessages = {
    rows: msgs.length,
    streaming: msgs.filter((m) => m.status === "streaming").length,
    ms: msgsMs,
  };
  const one = (sql: string, ...args: number[]) =>
    v.query<{ n: number }, number[]>(sql).get(...args)!.n;
  out.sweep = {
    chatsToArchive: one(
      `select count(*) as n from sessions where origin = 'chat' and archived_at is null and last_activity_at < ? and status <> 'running'`,
      NOW - ARCHIVE_IDLE_DAYS * DAY,
    ),
    chatsToDelete: one(
      `select count(*) as n from sessions where origin = 'chat' and archived_at < ? and status <> 'running'`,
      NOW - ARCHIVED_DELETE_DAYS * DAY,
    ),
    orphanRunsToDelete: one(
      `select count(*) as n from sessions where origin = 'automation' and automation_id is null and last_activity_at < ? and status <> 'running'`,
      NOW - ARCHIVED_DELETE_DAYS * DAY,
    ),
    expiredRuns: store.expiredRuns(NOW).length,
  };
  out.failures = fail;
  v.close(true);
  return out;
}
