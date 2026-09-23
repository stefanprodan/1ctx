// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// MCP results kept past the context and embedded resources, owned by
// their tool row and read by the mount under /mcp. The budget is applied
// when a send starts, under the runner's lock, so the tree a command
// mounts never loses a file while it reads.

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

export function readKept(
  db: Db,
  messageId: string,
  position: number,
): string | Uint8Array | null {
  const row = db
    .query<{ text: string | null; data: Uint8Array | null }, [string, number]>(
      "select text, data from mcp_kept_files where message_id = ? and position = ?",
    )
    .get(messageId, position);
  if (row === null) return null;
  return row.text ?? new Uint8Array(row.data ?? []);
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

// fork: the kept files of the copied rows, under their new ids
export function copyKeptFiles(
  db: Db,
  sourceSessionId: string,
  targetSessionId: string,
  messageIds: ReadonlyMap<string, string>,
): void {
  const insert = db.query(
    `insert into mcp_kept_files
       (message_id, position, session_id, folder, dir, name, bytes, text, data)
     select ?, position, ?, folder, dir, name, bytes, text, data
     from mcp_kept_files where message_id = ?`,
  );
  for (const [from, to] of messageIds) insert.run(to, targetSessionId, from);
  db.query(
    `update sessions set mcp_folders =
       (select mcp_folders from sessions where id = ?) where id = ?`,
  ).run(sourceSessionId, targetSessionId);
}
