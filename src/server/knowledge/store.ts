// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Live project text and its metadata over the migrated tables. Writes
// keep post-image versions, and recent files come from live rows rather
// than a saved catalog that could still name a deleted file.

import type {
  KnowledgeAuthor,
  KnowledgeCounts,
  KnowledgeFile,
  KnowledgeTotals,
} from "../../shared/contracts/knowledge.ts";
import type { RecentFile } from "../../shared/knowledge.ts";
import type { Db } from "../db/index.ts";
import { newId, sha256 } from "../lib/ids.ts";
import { tokens } from "../lib/tokens.ts";
import { RECENT_FILES } from "./limits.ts";
import {
  FILE_COLUMNS,
  type FileRaw,
  type FullRaw,
  fileOf,
  type KnowledgeRow,
  summary,
} from "./rows.ts";
import { kindOf, lineCount } from "./text.ts";
import { KnowledgeVersions } from "./versions.ts";

export { type KnowledgeRow, summary } from "./rows.ts";

export class KnowledgeStore extends KnowledgeVersions {
  constructor(private readonly filesDb: Db) {
    super(filesDb);
  }

  list(projectId: string): KnowledgeFile[] {
    return this.filesDb
      .query<FileRaw, [string]>(
        `select ${FILE_COLUMNS} from knowledge_files
       where project_id = ? order by name`,
      )
      .all(projectId)
      .map(fileOf);
  }

  read(projectId: string): KnowledgeRow[] {
    return this.filesDb
      .query<FullRaw, [string]>(
        "select * from knowledge_files where project_id = ? order by name",
      )
      .all(projectId)
      .map((raw) => ({
        ...fileOf(raw),
        text: raw.text,
        digest: raw.digest,
      }));
  }

  // the rows past after, in name order, without their text
  after(projectId: string, after: string | null): Generator<KnowledgeFile> {
    return this.stream(
      `select ${FILE_COLUMNS} from knowledge_files
       where project_id = ? and name > ? order by name`,
      [projectId, after ?? ""],
    );
  }

  // names are ASCII, so SQLite's lower() folds them as JavaScript does
  named(
    projectId: string,
    after: string | null,
    query: string,
  ): Generator<KnowledgeFile> {
    return this.stream(
      `select ${FILE_COLUMNS} from knowledge_files
       where project_id = ? and name > ? and instr(lower(name), ?) > 0
       order by name`,
      [projectId, after ?? "", query],
    );
  }

  // empty for a file gone
  text(projectId: string, id: string): string {
    return (
      this.filesDb
        .query<{ text: string }, [string, string]>(
          "select text from knowledge_files where project_id = ? and id = ?",
        )
        .get(projectId, id)?.text ?? ""
    );
  }

  // its own statement, finalized at the end, since a cached one left
  // mid-step by a caller that stops early refuses its next use
  private *stream(sql: string, params: string[]): Generator<KnowledgeFile> {
    const statement = this.filesDb.prepare<FileRaw, string[]>(sql);
    try {
      for (const raw of statement.iterate(...params)) yield fileOf(raw);
    } finally {
      statement.finalize();
    }
  }

  byId(projectId: string, id: string): KnowledgeRow | null {
    const raw = this.filesDb
      .query<FullRaw, [string, string]>(
        "select * from knowledge_files where project_id = ? and id = ?",
      )
      .get(projectId, id);
    return raw === null
      ? null
      : {
          ...fileOf(raw),
          text: raw.text,
          digest: raw.digest,
        };
  }

  byName(projectId: string, name: string): KnowledgeRow | null {
    const raw = this.filesDb
      .query<FullRaw, [string, string]>(
        "select * from knowledge_files where project_id = ? and name = ?",
      )
      .get(projectId, name);
    return raw === null
      ? null
      : {
          ...fileOf(raw),
          text: raw.text,
          digest: raw.digest,
        };
  }

  totals(projectId: string): KnowledgeTotals {
    return this.filesDb
      .query<KnowledgeTotals, [string]>(
        `select count(*) as files, coalesce(sum(bytes), 0) as bytes,
       coalesce(sum(tokens), 0) as tokens from knowledge_files
       where project_id = ?`,
      )
      .get(projectId)!;
  }

  counts(projectId: string): KnowledgeCounts {
    const { files, tokens } = this.totals(projectId);
    return { files, tokens };
  }

  // the files changed last, newest first
  latest(projectId: string, limit: number): KnowledgeFile[] {
    return this.filesDb
      .query<FileRaw, [string, number]>(
        `select ${FILE_COLUMNS} from knowledge_files where project_id = ?
       order by updated_at desc, rowid desc limit ?`,
      )
      .all(projectId, limit)
      .map(fileOf);
  }

  recent(projectId: string): RecentFile[] {
    return this.filesDb
      .query<RecentFile, [string, number]>(
        `select name, author_name as author, updated_at as updatedAt
       from knowledge_files where project_id = ?
       order by updated_at desc, rowid desc limit ?`,
      )
      .all(projectId, RECENT_FILES);
  }

  create(
    projectId: string,
    author: KnowledgeAuthor,
    name: string,
    text: string,
    now: number,
  ): KnowledgeFile {
    const id = newId();
    this.filesDb
      .query(
        `insert into knowledge_files
       (id, project_id, name, kind, text, bytes, lines, digest, tokens,
        revision, author_kind, author_id, author_name, session_id, origin,
        created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        name,
        kindOf(name),
        text,
        Buffer.byteLength(text),
        lineCount(text),
        sha256(text),
        tokens(text),
        author.kind,
        author.id,
        author.name,
        author.sessionId,
        author.origin,
        now,
        now,
      );
    const file = summary(this.byId(projectId, id)!);
    this.insert(file, text, false);
    return file;
  }

  replace(
    current: KnowledgeFile,
    author: KnowledgeAuthor,
    text: string,
    now: number,
  ): KnowledgeFile {
    this.filesDb
      .query(
        `update knowledge_files set text = ?, bytes = ?, lines = ?, digest = ?,
       tokens = ?, revision = revision + 1, author_kind = ?, author_id = ?,
       author_name = ?, session_id = ?, origin = ?, updated_at = ?
       where project_id = ? and id = ?`,
      )
      .run(
        text,
        Buffer.byteLength(text),
        lineCount(text),
        sha256(text),
        tokens(text),
        author.kind,
        author.id,
        author.name,
        author.sessionId,
        author.origin,
        now,
        current.projectId,
        current.id,
      );
    const file = summary(this.byId(current.projectId, current.id)!);
    this.insert(file, text, false);
    return file;
  }

  // the same text under a new name, a version like any write
  rename(
    current: KnowledgeRow,
    author: KnowledgeAuthor,
    name: string,
    now: number,
  ): KnowledgeFile {
    this.filesDb
      .query(
        `update knowledge_files set name = ?, kind = ?,
       revision = revision + 1, author_kind = ?, author_id = ?,
       author_name = ?, session_id = ?, origin = ?, updated_at = ?
       where project_id = ? and id = ?`,
      )
      .run(
        name,
        kindOf(name),
        author.kind,
        author.id,
        author.name,
        author.sessionId,
        author.origin,
        now,
        current.projectId,
        current.id,
      );
    const file = summary(this.byId(current.projectId, current.id)!);
    this.insert(file, current.text, false);
    return file;
  }

  remove(
    current: KnowledgeFile,
    author: KnowledgeAuthor,
    now: number,
  ): KnowledgeFile {
    const file = {
      ...current,
      author,
      revision: current.revision + 1,
      updatedAt: now,
    };
    this.insert(file, "", true, current);
    this.filesDb
      .query("delete from knowledge_files where project_id = ? and id = ?")
      .run(current.projectId, current.id);
    return file;
  }
}
