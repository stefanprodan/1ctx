// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// MCP results kept past the context and embedded resources, owned by
// their tool row and read by the mount under /mcp. The budget is applied
// when a send starts, under the runner's lock, so the tree a command
// mounts never loses a file while it reads. An ended session's files are
// packed by the sessions job and unpacked by Fork, so the mount only
// ever reads raw ones.

import type { Db } from "../db/index.ts";

export type KeptFile = {
  folder: number;
  dir: string;
  name: string;
  text: string | null;
  data: Uint8Array | null;
  bytes: number;
};

export type KeptEntry = {
  messageId: string;
  position: number;
  path: string;
  bytes: number;
};

// in bytes; a smaller file gains too little to pay a decode
export const KEPT_PACK_FROM = 1024;

const KEPT_PACK_LEVEL = 3;

// the raw files still worth trying, as a condition on mcp_kept_files;
// the mcp_kept_files_packable index in 0041 repeats it term for term
export const KEPT_PACKABLE = `mcp_kept_files.packed = 0
  and mcp_kept_files.bytes >= ${KEPT_PACK_FROM}`;

// a session's files to try, in packing order, read from the covering
// candidate index alone
export const KEPT_PENDING = `select message_id, position, bytes
  from mcp_kept_files where session_id = ? and ${KEPT_PACKABLE}
  order by folder, position`;

// fixed, so no frame or file name reaches a log or a body
export const KEPT_UNPACK_ERROR = "a packed kept file did not decode";
export const KEPT_PACKED_READ = "a packed kept file was read";

// the sessions holding files to try, walked by id from after a cursor,
// over the covering candidate index alone; ids are random, so the walk
// has no age order
export const KEPT_WALK = `select distinct session_id from mcp_kept_files
  where ${KEPT_PACKABLE} and session_id > ?
  order by session_id limit ?`;

// a file to try, by key, with its raw size
export type KeptPending = {
  messageId: string;
  position: number;
  bytes: number;
};

export type KeptWrite = "packed" | "refused" | "skipped";

// the file's place under /mcp
export function keptPath(dir: string, name: string): string {
  return `/mcp/${dir}/${name}`;
}

// inside the transaction that ends the tool row
export function writeKeptFiles(
  db: Db,
  messageId: string,
  files: readonly KeptFile[],
): void {
  if (files.length === 0) return;
  const row = db
    .query<{ session_id: string }, [string]>(
      "select session_id from messages where id = ?",
    )
    .get(messageId);
  if (row === null) return;
  const insert = db.query(
    `insert into mcp_kept_files
       (message_id, position, session_id, folder, dir, name, bytes, text, data)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  files.forEach((file, position) => {
    insert.run(
      messageId,
      position,
      row.session_id,
      file.folder,
      file.dir,
      file.name,
      file.bytes,
      file.text,
      file.data,
    );
  });
  const top = Math.max(...files.map((file) => file.folder));
  db.query(
    "update sessions set mcp_folders = max(mcp_folders, ?) where id = ?",
  ).run(top, row.session_id);
}

export function listKept(db: Db, sessionId: string): KeptEntry[] {
  return db
    .query<
      {
        message_id: string;
        position: number;
        dir: string;
        name: string;
        bytes: number;
      },
      [string]
    >(
      `select message_id, position, dir, name, bytes from mcp_kept_files
       where session_id = ? order by folder, position`,
    )
    .all(sessionId)
    .map((row) => ({
      messageId: row.message_id,
      position: row.position,
      path: keptPath(row.dir, row.name),
      bytes: row.bytes,
    }));
}

// the file's bytes, text read as a blob, so the command worker gets them
// transferred rather than copied on the server's thread
export function readKept(
  db: Db,
  messageId: string,
  position: number,
): Uint8Array | null {
  const row = db
    .query<{ data: Uint8Array | null; packed: number }, [string, number]>(
      `select coalesce(cast(text as blob), data) as data, packed
       from mcp_kept_files where message_id = ? and position = ?`,
    )
    .get(messageId, position);
  if (row === null) return null;
  // only ended sessions are packed, and they never mount
  if (row.packed === 1) throw new Error(KEPT_PACKED_READ);
  return row.data ?? new Uint8Array();
}

export function walkKept(db: Db, after: string, limit: number): string[] {
  return db
    .query<{ session_id: string }, [string, number]>(KEPT_WALK)
    .all(after, limit)
    .map((row) => row.session_id);
}

// the session's files to try, in packing order
export function pendingKept(db: Db, sessionId: string): KeptPending[] {
  return db
    .query<{ message_id: string; position: number; bytes: number }, [string]>(
      KEPT_PENDING,
    )
    .all(sessionId)
    .map((row) => ({
      messageId: row.message_id,
      position: row.position,
      bytes: row.bytes,
    }));
}

// a file's stored bytes, text as its bytes: every reader takes a file
// as bytes, so a frame of them unpacks to the same file
export function readKeptRaw(
  db: Db,
  messageId: string,
  position: number,
): Uint8Array | null {
  const row = db
    .query<{ raw: Uint8Array | null }, [string, number]>(
      `select coalesce(cast(text as blob), data) as raw from mcp_kept_files
       where message_id = ? and position = ?`,
    )
    .get(messageId, position);
  return row === null ? null : (row.raw ?? new Uint8Array());
}

// on Bun's thread pool, so the event loop runs while a large file
// compresses
export function compressKept(raw: Uint8Array): Promise<Uint8Array> {
  return Bun.zstdCompress(raw, { level: KEPT_PACK_LEVEL });
}

/**
 * In the caller's transaction: the frame stored over the raw file, or
 * the file left raw for good when the frame is no smaller or the bytes
 * read disagree with its size, which would fail every fork's check.
 * Only a row still at 0 is written; skipped when the row changed or
 * went.
 */
export function writeKeptFrame(
  db: Db,
  file: KeptPending,
  rawLength: number,
  frame: Uint8Array,
): KeptWrite {
  const keep = frame.byteLength >= rawLength || rawLength !== file.bytes;
  const changes = keep
    ? db
        .query(
          `update mcp_kept_files set packed = -1
           where message_id = ? and position = ? and packed = 0`,
        )
        .run(file.messageId, file.position).changes
    : db
        .query(
          `update mcp_kept_files set packed = 1, text = null, data = ?
           where message_id = ? and position = ? and packed = 0`,
        )
        .run(frame, file.messageId, file.position).changes;
  if (changes === 0) return "skipped";
  return keep ? "refused" : "packed";
}

function unpackKept(frame: Uint8Array, bytes: number): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = Bun.zstdDecompressSync(frame);
  } catch {
    throw new Error(KEPT_UNPACK_ERROR);
  }
  if (raw.byteLength !== bytes) throw new Error(KEPT_UNPACK_ERROR);
  return raw;
}

/**
 * The oldest folders dropped until the session is inside its budget, then
 * the number its next folder takes and the bytes and files still kept.
 * Called as a send starts; the files of rows past afterSeq, which a
 * regenerate is about to delete, count for nothing.
 */
export function startKept(
  db: Db,
  sessionId: string,
  caps: { mcpKeptBytes: number; mcpKeptFiles: number },
  afterSeq: number | null = null,
): { next: number; used: number; files: number } {
  const folders = db
    .query<
      { folder: number; bytes: number; files: number },
      [string, string, number]
    >(
      `select folder, sum(bytes) as bytes, count(*) as files
       from mcp_kept_files where session_id = ?
       and message_id not in
         (select id from messages where session_id = ? and seq > ?)
       group by folder order by folder`,
    )
    .all(sessionId, sessionId, afterSeq ?? Number.MAX_SAFE_INTEGER);
  let bytes = folders.reduce((sum, f) => sum + f.bytes, 0);
  let files = folders.reduce((sum, f) => sum + f.files, 0);
  const drop: number[] = [];
  for (const folder of folders) {
    if (bytes <= caps.mcpKeptBytes && files <= caps.mcpKeptFiles) break;
    drop.push(folder.folder);
    bytes -= folder.bytes;
    files -= folder.files;
  }
  if (drop.length > 0) {
    db.query(
      `delete from mcp_kept_files where session_id = ? and folder <= ?`,
    ).run(sessionId, drop[drop.length - 1]!);
  }
  const row = db
    .query<{ mcp_folders: number }, [string]>(
      "select mcp_folders from sessions where id = ?",
    )
    .get(sessionId);
  return { next: (row?.mcp_folders ?? 0) + 1, used: bytes, files };
}

// fork: the kept files of the copied rows, under their new ids; a fork
// is live, so a packed file is written raw, its bytes in data
export function copyKeptFiles(
  db: Db,
  sourceSessionId: string,
  targetSessionId: string,
  messageIds: ReadonlyMap<string, string>,
): void {
  const copy = db.query(
    `insert into mcp_kept_files (message_id, position, session_id, folder,
       dir, name, bytes, text, data, packed)
     select ?, position, ?, folder, dir, name, bytes, text, data, packed
     from mcp_kept_files where message_id = ? and packed <> 1`,
  );
  const packed = db.query<
    {
      position: number;
      folder: number;
      dir: string;
      name: string;
      bytes: number;
      data: Uint8Array;
    },
    [string]
  >(
    `select position, folder, dir, name, bytes, data
     from mcp_kept_files where message_id = ? and packed = 1`,
  );
  const insert = db.query(
    `insert into mcp_kept_files (message_id, position, session_id, folder,
       dir, name, bytes, text, data)
     values (?, ?, ?, ?, ?, ?, ?, null, ?)`,
  );
  for (const [from, to] of messageIds) {
    copy.run(to, targetSessionId, from);
    for (const row of packed.all(from)) {
      const raw = unpackKept(row.data, row.bytes);
      insert.run(
        to,
        row.position,
        targetSessionId,
        row.folder,
        row.dir,
        row.name,
        row.bytes,
        raw,
      );
    }
  }
  db.query(
    `update sessions set mcp_folders =
       (select mcp_folders from sessions where id = ?) where id = ?`,
  ).run(sourceSessionId, targetSessionId);
}
