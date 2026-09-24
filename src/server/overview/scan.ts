// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The storage scan: every query the storage answer needs, over one
// connection, read once and shaped into plain data the worker can post.
// Nothing here knows a zone: what was added when is summed by quarter
// hour of UTC, which every zone's midnight falls on, so one scan answers
// any zone's days. On disk is dbstat; stored is the tables' own `bytes`
// or octet_length of the text, which counts without decoding it.

import { statSync } from "node:fs";
import { basename } from "node:path";
import type { StorageFile } from "../../shared/api/admin.ts";
import type { Db } from "../db/index.ts";

export type ScanInput = {
  now: number;
  // rows created before it are left out of the slots
  since: number;
};

// one dbstat name: a table or an index with the table it belongs to
export type PageRow = {
  name: string;
  table: string;
  kind: "table" | "index";
  bytes: number;
};

// what a session holds, stored: its rows' text, and the files kept
// with it
export type SessionSum = {
  id: string;
  projectId: string;
  origin: "chat" | "automation";
  automationId: string | null;
  title: string;
  messages: number;
  messageBytes: number;
  openedBytes: number;
  uploadBytes: number;
  scratchBytes: number;
  mcpBytes: number;
};

export type ProjectRow = {
  id: string;
  kind: "personal" | "team";
  name: string;
  owner: string;
};

export type AutomationRow = {
  id: string;
  projectId: string;
  name: string;
  retentionDays: number;
};

// a project's knowledge: live files, the versions of live files, and
// the versions left by deleted files
export type KnowledgeSum = {
  projectId: string;
  files: number;
  liveVersions: number;
  deletedVersions: number;
};

export type ScanResult = {
  readAt: number;
  file: StorageFile;
  pages: PageRow[];
  rows: Record<string, number>;
  sessions: SessionSum[];
  projects: ProjectRow[];
  automations: AutomationRow[];
  knowledge: KnowledgeSum[];
  // stored bytes and rows added per quarter hour of UTC since the
  // input's cut
  slots: Slot[];
  staging: number;
  digests: number;
  // usage rows in all, and those of runs of tasks that still exist
  usage: { rows: number; runRows: number };
};

export const SLOT_MS = 900_000;

// a quarter hour, the stored bytes and the rows created in it
export type Slot = [slot: number, bytes: number, rows: number];

// the text a message row stores; the short columns are left out
export const MESSAGE_BYTES =
  "octet_length(content) + octet_length(reasoning) + octet_length(html)" +
  " + coalesce(octet_length(error), 0)" +
  " + coalesce(octet_length(reasoning_details), 0)" +
  " + coalesce(octet_length(tool_calls), 0)" +
  " + coalesce(octet_length(uploads), 0)";

const AUTO_VACUUM = ["none", "full", "incremental"] as const;

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

function pragma<T>(db: Db, name: string): T {
  return db.query<Record<string, T>, []>(`pragma ${name}`).get()?.[name] as T;
}

function fileFacts(db: Db): StorageFile {
  const memory = db.filename === "" || db.filename === ":memory:";
  const path = db.filename;
  const last = db
    .query<{ id: string }, []>(
      "select id from migrations order by rowid desc limit 1",
    )
    .get();
  return {
    name: memory ? ":memory:" : basename(path),
    bytes: memory ? 0 : sizeOf(path),
    walBytes: memory ? 0 : sizeOf(`${path}-wal`),
    shmBytes: memory ? 0 : sizeOf(`${path}-shm`),
    pageSize: pragma<number>(db, "page_size"),
    pages: pragma<number>(db, "page_count"),
    freePages: pragma<number>(db, "freelist_count"),
    autoVacuum: AUTO_VACUUM[pragma<number>(db, "auto_vacuum")] ?? "none",
    journalMode: pragma<string>(db, "journal_mode"),
    sqliteVersion: db
      .query<{ v: string }, []>("select sqlite_version() as v")
      .get()!.v,
    lastMigration: last?.id ?? null,
  };
}

function pages(db: Db): { pages: PageRow[]; tables: string[] } {
  const schema = db
    .query<{ name: string; type: string; tbl_name: string }, []>(
      "select name, type, tbl_name from sqlite_schema where type in ('table', 'index')",
    )
    .all();
  const owner = new Map(schema.map((row) => [row.name, row]));
  const rows = db
    .query<{ name: string; bytes: number }, []>(
      "select name, sum(pgsize) as bytes from dbstat group by name",
    )
    .all();
  return {
    pages: rows.map(({ name, bytes }) => {
      const entry = owner.get(name);
      return {
        name,
        table: entry?.type === "index" ? entry.tbl_name : name,
        kind: entry?.type === "index" ? "index" : "table",
        bytes,
      };
    }),
    tables: schema
      .filter((row) => row.type === "table")
      .map((r) => r.name)
      .concat("sqlite_schema"),
  };
}

function rowCounts(db: Db, tables: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = db
      .query<{ n: number }, []>(`select count(*) as n from "${table}"`)
      .get()!.n;
  }
  return counts;
}

type Sum = { id: string; bytes: number };

const sums = (db: Db, sql: string): Map<string, number> =>
  new Map(
    db
      .query<Sum, []>(sql)
      .all()
      .map((row) => [row.id, row.bytes]),
  );

function sessions(db: Db): SessionSum[] {
  const messages = db
    .query<{ id: string; count: number; bytes: number }, []>(
      `select session_id as id, count(*) as count, sum(${MESSAGE_BYTES}) as bytes,
       count(*) as rows
         from messages group by session_id`,
    )
    .all();
  const byMessage = new Map(messages.map((row) => [row.id, row]));
  const opened = sums(
    db,
    `select m.session_id as id, sum(o.bytes) as bytes from opened_files o
       join messages m on m.id = o.message_id group by m.session_id`,
  );
  const uploads = sums(
    db,
    "select session_id as id, bytes from session_uploads",
  );
  const scratch = sums(
    db,
    "select session_id as id, bytes from session_scratch",
  );
  const mcp = sums(
    db,
    "select session_id as id, sum(bytes) as bytes from mcp_kept_files group by session_id",
  );
  return db
    .query<
      {
        id: string;
        projectId: string;
        origin: "chat" | "automation";
        automationId: string | null;
        title: string;
      },
      []
    >(
      `select id, project_id as projectId, origin, automation_id as automationId,
              title from sessions`,
    )
    .all()
    .map((row) => ({
      ...row,
      messages: byMessage.get(row.id)?.count ?? 0,
      messageBytes: byMessage.get(row.id)?.bytes ?? 0,
      openedBytes: opened.get(row.id) ?? 0,
      uploadBytes: uploads.get(row.id) ?? 0,
      scratchBytes: scratch.get(row.id) ?? 0,
      mcpBytes: mcp.get(row.id) ?? 0,
    }));
}

function knowledge(db: Db): KnowledgeSum[] {
  const files = sums(
    db,
    "select project_id as id, sum(bytes) as bytes from knowledge_files group by project_id",
  );
  const live = sums(
    db,
    `select v.project_id as id, sum(v.bytes) as bytes from knowledge_versions v
       where exists (select 1 from knowledge_files f where f.id = v.file_id)
       group by v.project_id`,
  );
  const gone = sums(
    db,
    `select v.project_id as id, sum(v.bytes) as bytes from knowledge_versions v
       where not exists (select 1 from knowledge_files f where f.id = v.file_id)
       group by v.project_id`,
  );
  const ids = new Set([...files.keys(), ...live.keys(), ...gone.keys()]);
  return [...ids].map((projectId) => ({
    projectId,
    files: files.get(projectId) ?? 0,
    liveVersions: live.get(projectId) ?? 0,
    deletedVersions: gone.get(projectId) ?? 0,
  }));
}

// What was added when: each row, and its stored bytes, on the quarter
// hour its creation time falls in. A live knowledge file takes its last
// write, since a replacement keeps created_at; opened and kept files
// take their message's time, scratch its last use (it has no creation
// time), a skill's body and files the fetch that wrote them.
const SLOT_SOURCES = [
  `select created_at / ${SLOT_MS} as slot, sum(${MESSAGE_BYTES}) as bytes,
       count(*) as rows
     from messages where created_at >= ? group by slot`,
  `select m.created_at / ${SLOT_MS} as slot, sum(o.bytes) as bytes,
       count(*) as rows
     from opened_files o join messages m on m.id = o.message_id
     where m.created_at >= ? group by slot`,
  `select m.created_at / ${SLOT_MS} as slot, sum(k.bytes) as bytes,
       count(*) as rows
     from mcp_kept_files k join messages m on m.id = k.message_id
     where m.created_at >= ? group by slot`,
  `select updated_at / ${SLOT_MS} as slot, sum(bytes) as bytes,
       count(*) as rows
     from knowledge_files where updated_at >= ? group by slot`,
  `select written_at / ${SLOT_MS} as slot, sum(bytes) as bytes,
       count(*) as rows
     from knowledge_versions where written_at >= ? group by slot`,
  `select created_at / ${SLOT_MS} as slot, sum(bytes) as bytes,
       count(*) as rows
     from session_upload_files where created_at >= ? group by slot`,
  `select created_at / ${SLOT_MS} as slot, sum(bytes) as bytes,
       count(*) as rows
     from upload_staged where created_at >= ? group by slot`,
  `select used_at / ${SLOT_MS} as slot, sum(bytes) as bytes,
       count(*) as rows
     from session_scratch where used_at >= ? group by slot`,
  `select fetched_at / ${SLOT_MS} as slot, sum(octet_length(body)) as bytes,
       count(*) as rows
     from skills where fetched_at >= ? group by slot`,
  `select s.fetched_at / ${SLOT_MS} as slot, sum(f.bytes) as bytes,
       count(*) as rows
     from skill_files f join skills s on s.id = f.skill_id
     where s.fetched_at >= ? group by slot`,
];

function slots(db: Db, since: number): Slot[] {
  const totals = new Map<number, Slot>();
  for (const sql of SLOT_SOURCES) {
    for (const row of db
      .query<{ slot: number; bytes: number; rows: number }, [number]>(sql)
      .all(since)) {
      const held = totals.get(row.slot);
      if (held) {
        held[1] += row.bytes;
        held[2] += row.rows;
      } else totals.set(row.slot, [row.slot, row.bytes, row.rows]);
    }
  }
  return [...totals.values()].sort((a, b) => a[0] - b[0]);
}

const total = (db: Db, sql: string): number =>
  db.query<{ bytes: number | null }, []>(sql).get()?.bytes ?? 0;

function usage(db: Db): ScanResult["usage"] {
  return db
    .query<ScanResult["usage"], []>(
      `select count(*) as rows,
              count(s.id) as runRows
         from usage u left join sessions s
           on s.id = u.session_id and s.automation_id is not null`,
    )
    .get()!;
}

// one read transaction, so every statement sees the same WAL snapshot
export function scan(db: Db, input: ScanInput): ScanResult {
  db.exec("begin");
  try {
    return read(db, input);
  } finally {
    db.exec("rollback");
  }
}

function read(db: Db, input: ScanInput): ScanResult {
  const { pages: pageRows, tables } = pages(db);
  return {
    readAt: input.now,
    file: fileFacts(db),
    pages: pageRows,
    rows: rowCounts(db, tables),
    sessions: sessions(db),
    projects: db
      .query<ProjectRow, []>(
        `select p.id, p.kind, p.name, u.username as owner
           from projects p join users u on u.id = p.owner_id`,
      )
      .all(),
    automations: db
      .query<AutomationRow, []>(
        `select id, project_id as projectId, name,
                retention_days as retentionDays from automations`,
      )
      .all(),
    knowledge: knowledge(db),
    slots: slots(db, input.since),
    staging: total(db, "select sum(bytes) as bytes from upload_staged_files"),
    digests: total(
      db,
      "select sum(octet_length(body)) as bytes from mcp_digests",
    ),
    usage: usage(db),
  };
}
