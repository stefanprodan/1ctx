// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A session's working files, apart from the shared base: any bytes, no
// versions, one revision per session so a command commits only against
// the scratch it mounted. Rows go with the session, or idle, by sweep.

import type { Db } from "../db/index.ts";
import { DAY_MS } from "../lib/clock.ts";
import { Conflict } from "../lib/errors.ts";
import { heldSessions } from "./queue.ts";

export type ScratchFile = {
  path: string;
  data: Uint8Array;
  mode: number;
};

export type Scratch = {
  cwd: string;
  revision: number;
  bytes: number;
  files: number;
  entries: ScratchFile[];
};

export type ScratchChanges = {
  written: readonly ScratchFile[];
  removed: readonly string[];
  cwd: string;
};

// a file's size counts its name, so empty files cannot store megabytes
// of paths under the byte cap
const STORED_BYTES = "length(data) + length(cast(path as blob))";

export class ScratchStore {
  constructor(private readonly db: Db) {}

  read(sessionId: string): Scratch {
    const row = this.db
      .query<Omit<Scratch, "entries">, [string]>(
        `select cwd, revision, bytes, files from session_scratch
         where session_id = ?`,
      )
      .get(sessionId);
    return {
      ...(row ?? { cwd: "/knowledge", revision: 0, bytes: 0, files: 0 }),
      entries: this.db
        .query<ScratchFile, [string]>(
          `select path, data, mode from session_scratch_files
           where session_id = ? order by path`,
        )
        .all(sessionId),
    };
  }

  // the last command's time, the mtime its files mount with, since a
  // file keeps no time of its own
  usedAt(sessionId: string): number | null {
    return (
      this.db
        .query<{ used_at: number }, [string]>(
          "select used_at from session_scratch where session_id = ?",
        )
        .get(sessionId)?.used_at ?? null
    );
  }

  // The caller owns the transaction so knowledge and scratch roll back together.
  write(
    sessionId: string,
    expectedRevision: number,
    changes: ScratchChanges,
    now: number,
  ): void {
    const current = this.db
      .query<{ revision: number }, [string]>(
        "select revision from session_scratch where session_id = ?",
      )
      .get(sessionId);
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new Conflict("the scratch changed while the command ran");
    }
    this.db
      .query(
        `insert into session_scratch
         (session_id, cwd, revision, bytes, files, used_at)
         values (?, ?, ?, 0, 0, ?)
         on conflict (session_id) do update set
           cwd = excluded.cwd, revision = excluded.revision,
           used_at = excluded.used_at`,
      )
      .run(sessionId, changes.cwd, expectedRevision + 1, now);
    for (const path of changes.removed) {
      this.db
        .query(
          "delete from session_scratch_files where session_id = ? and path = ?",
        )
        .run(sessionId, path);
    }
    for (const file of changes.written) {
      this.db
        .query(
          `insert into session_scratch_files (session_id, path, data, mode)
           values (?, ?, ?, ?)
           on conflict (session_id, path) do update set
             data = excluded.data, mode = excluded.mode`,
        )
        .run(sessionId, file.path, file.data, file.mode);
    }
    this.db
      .query(
        `update session_scratch set (bytes, files) = (
           select coalesce(sum(${STORED_BYTES}), 0), count(*)
           from session_scratch_files where session_id = ?
         ) where session_id = ?`,
      )
      .run(sessionId, sessionId);
  }

  // the stored names and sizes, which a commit checks inside its
  // transaction rather than trusting what the command worker counted
  sizes(sessionId: string): { path: string; bytes: number }[] {
    return this.db
      .query<{ path: string; bytes: number }, [string]>(
        `select path, ${STORED_BYTES} as bytes from session_scratch_files
         where session_id = ?`,
      )
      .all(sessionId);
  }

  // an archived chat never runs a command again; its files go with the row
  drop(sessionId: string): void {
    this.db
      .query("delete from session_scratch where session_id = ?")
      .run(sessionId);
  }

  // the sessions a command runs in now, whose scratch no sweep takes
  held(): ReadonlySet<string> {
    return heldSessions();
  }

  sweep(now: number, idleDays: number, held: ReadonlySet<string>): number {
    const expired = this.db
      .query<{ session_id: string }, [number]>(
        "select session_id from session_scratch where used_at < ?",
      )
      .all(now - idleDays * DAY_MS);
    let count = 0;
    for (const row of expired) {
      if (held.has(row.session_id)) continue;
      const deleted = this.db
        .query(
          "delete from session_scratch where session_id = ? returning session_id",
        )
        .get(row.session_id);
      if (deleted !== null) count++;
    }
    return count;
  }
}
