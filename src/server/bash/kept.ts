// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Kept MCP files, owned by their tool row and mounted under /mcp.

import type { Db } from "../db/index.ts";
import {
  sessionWorkspace,
  type Workspace,
  workspaceId,
  workspaceOf,
  workspaceSession,
} from "./workspace.ts";

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
    .query<
      {
        session_id: string;
        origin: "chat" | "automation" | "channel";
        agent_id: string | null;
        parent_session_id: string | null;
      },
      [string]
    >(
      `select messages.session_id, sessions.origin, sends.agent_id,
         sessions.parent_session_id
       from messages
       join sessions on sessions.id = messages.session_id
       join sends on sends.id = messages.send_id
       where messages.id = ?`,
    )
    .get(messageId);
  if (row === null) return;
  const workspace =
    row.parent_session_id !== null || row.agent_id === null
      ? sessionWorkspace(row.session_id)
      : workspaceOf(row.session_id, row.origin, row.agent_id);
  const keptWorkspace =
    workspace.id === workspace.sessionId ? null : workspace.id;
  const insert = db.query(
    `insert into mcp_kept_files
       (message_id, position, session_id, folder, dir, name, bytes, text, data,
        workspace_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      keptWorkspace,
    );
  });
  const top = Math.max(...files.map((file) => file.folder));
  db.query(
    `insert into session_workspaces (workspace_id, session_id, mcp_folders)
     values (?, ?, ?)
     on conflict (workspace_id) do update set
       mcp_folders = max(mcp_folders, excluded.mcp_folders)`,
  ).run(workspace.id, workspace.sessionId, top);
}

export function listKept(db: Db, workspace: Workspace): KeptEntry[] {
  return db
    .query<
      {
        message_id: string;
        position: number;
        dir: string;
        name: string;
        bytes: number;
      },
      [string, string | null]
    >(
      `select message_id, position, dir, name, bytes from mcp_kept_files
       where session_id = ? and workspace_id is ? order by folder, position`,
    )
    .all(
      workspaceSession(workspace),
      workspace.id === workspace.sessionId ? null : workspace.id,
    )
    .map((row) => ({
      messageId: row.message_id,
      position: row.position,
      path: keptPath(row.dir, row.name),
      bytes: row.bytes,
    }));
}

// text read as a blob, so the command worker gets the bytes transferred
// rather than copied on the server's thread, and a frame of them unpacks
// to the same file
function keptBytes(
  db: Db,
  messageId: string,
  position: number,
): { raw: Uint8Array; packed: boolean } | null {
  const row = db
    .query<{ raw: Uint8Array | null; packed: number }, [string, number]>(
      `select coalesce(cast(text as blob), data) as raw, packed
       from mcp_kept_files where message_id = ? and position = ?`,
    )
    .get(messageId, position);
  if (row === null) return null;
  return { raw: row.raw ?? new Uint8Array(), packed: row.packed === 1 };
}

export function readKept(
  db: Db,
  messageId: string,
  position: number,
): Uint8Array | null {
  const row = keptBytes(db, messageId, position);
  if (row === null) return null;
  // only ended sessions are packed, and they never mount
  if (row.packed) throw new Error(KEPT_PACKED_READ);
  return row.raw;
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

// a file's stored bytes, packed or not
export function readKeptRaw(
  db: Db,
  messageId: string,
  position: number,
): Uint8Array | null {
  return keptBytes(db, messageId, position)?.raw ?? null;
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
  workspace: Workspace,
  caps: { mcpKeptBytes: number; mcpKeptFiles: number },
  afterSeq: number | null = null,
): { next: number; used: number; files: number } {
  const id = workspaceId(workspace);
  const sessionId = workspaceSession(workspace);
  const keptWorkspace = id === sessionId ? null : id;
  const folders = db
    .query<
      { folder: number; bytes: number; files: number },
      [string, string | null, string, number]
    >(
      `select folder, sum(bytes) as bytes, count(*) as files
       from mcp_kept_files where session_id = ? and workspace_id is ?
       and message_id not in
         (select id from messages where session_id = ? and seq > ?)
       group by folder order by folder`,
    )
    .all(
      sessionId,
      keptWorkspace,
      sessionId,
      afterSeq ?? Number.MAX_SAFE_INTEGER,
    );
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
      `delete from mcp_kept_files
       where session_id = ? and workspace_id is ? and folder <= ?`,
    ).run(sessionId, keptWorkspace, drop[drop.length - 1]!);
  }
  const row = db
    .query<{ mcp_folders: number }, [string]>(
      "select mcp_folders from session_workspaces where workspace_id = ?",
    )
    .get(id);
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
       dir, name, bytes, text, data, packed, workspace_id)
     select ?, position, ?, folder, dir, name, bytes, text, data, packed, ?
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
       dir, name, bytes, text, data, workspace_id)
     values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
  );
  for (const [from, to] of messageIds) {
    copy.run(to, targetSessionId, null, from);
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
        null,
      );
    }
  }
  db.query(
    `insert into session_workspaces (workspace_id, session_id, mcp_folders)
     select ?, ?, mcp_folders from session_workspaces
     where workspace_id = ?
     on conflict (workspace_id) do update set
       mcp_folders = excluded.mcp_folders`,
  ).run(targetSessionId, targetSessionId, sourceSessionId);
}
