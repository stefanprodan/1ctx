// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  KnowledgeAuthor,
  KnowledgeCounts,
  KnowledgeFile,
  KnowledgeTotals,
} from "../../shared/contracts/knowledge.ts";
import { kindOf } from "../../shared/knowledge.ts";
import { newId, sha256 } from "../lib/ids.ts";
import { tokens } from "../lib/tokens.ts";
import {
  FILE_COLUMNS,
  type FileRaw,
  type FullRaw,
  fileOf,
  type KnowledgeRow,
  rowOf,
  summary,
} from "./rows.ts";
import { lineCount } from "./text.ts";
import { KnowledgeVersions } from "./versions.ts";

export { type KnowledgeRow, summary } from "./rows.ts";

// the columns a text sets: bytes, lines, digest and tokens
const measure = (text: string) =>
  [
    Buffer.byteLength(text),
    lineCount(text),
    sha256(text),
    tokens(text),
  ] as const;

// a doc as a command mounts it, its text as bytes
export type MountedDoc = KnowledgeFile & { data: Uint8Array };

export class KnowledgeStore extends KnowledgeVersions {
  list(projectId: string): KnowledgeFile[] {
    return this.db
      .query<FileRaw, [string]>(
        `select ${FILE_COLUMNS} from knowledge_files
       where project_id = ? order by name`,
      )
      .all(projectId)
      .map(fileOf);
  }

  read(projectId: string): KnowledgeRow[] {
    return this.db
      .query<FullRaw, [string]>(
        "select * from knowledge_files where project_id = ? order by name",
      )
      .all(projectId)
      .map(rowOf);
  }

  // the live rows with their text as bytes, which a command's mount
  // transfers to its worker as they come from SQLite
  mounted(projectId: string): MountedDoc[] {
    return this.db
      .query<FileRaw & { data: Uint8Array }, [string]>(
        `select ${FILE_COLUMNS}, cast(text as blob) as data
         from knowledge_files where project_id = ? order by name`,
      )
      .all(projectId)
      .map((raw) => ({ ...fileOf(raw), data: raw.data }));
  }

  // every live file's id, in name order: a search's snapshot
  fileIds(projectId: string): string[] {
    return this.db
      .query<{ id: string }, [string]>(
        "select id from knowledge_files where project_id = ? order by name",
      )
      .all(projectId)
      .map((row) => row.id);
  }

  // a file's metadata and text from one read, so both are one
  // revision's; null for a file gone
  withText(
    projectId: string,
    id: string,
  ): { file: KnowledgeFile; text: string } | null {
    const raw = this.db
      .query<FileRaw & { text: string }, [string, string]>(
        `select ${FILE_COLUMNS}, text from knowledge_files
         where project_id = ? and id = ?`,
      )
      .get(projectId, id);
    return raw === null ? null : { file: fileOf(raw), text: raw.text };
  }

  file(projectId: string, id: string): KnowledgeFile | null {
    const raw = this.db
      .query<FileRaw, [string, string]>(
        `select ${FILE_COLUMNS} from knowledge_files where project_id = ? and id = ?`,
      )
      .get(projectId, id);
    return raw === null ? null : fileOf(raw);
  }

  // by its name, without its text
  fileNamed(projectId: string, name: string): KnowledgeFile | null {
    const raw = this.db
      .query<FileRaw, [string, string]>(
        `select ${FILE_COLUMNS} from knowledge_files where project_id = ? and name = ?`,
      )
      .get(projectId, name);
    return raw === null ? null : fileOf(raw);
  }

  byId(projectId: string, id: string): KnowledgeRow | null {
    const raw = this.db
      .query<FullRaw, [string, string]>(
        "select * from knowledge_files where project_id = ? and id = ?",
      )
      .get(projectId, id);
    return raw === null ? null : rowOf(raw);
  }

  byName(projectId: string, name: string): KnowledgeRow | null {
    const raw = this.db
      .query<FullRaw, [string, string]>(
        "select * from knowledge_files where project_id = ? and name = ?",
      )
      .get(projectId, name);
    return raw === null ? null : rowOf(raw);
  }

  totals(projectId: string): KnowledgeTotals {
    return this.db
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
    return this.db
      .query<FileRaw, [string, number]>(
        `select ${FILE_COLUMNS} from knowledge_files where project_id = ?
       order by updated_at desc, rowid desc limit ?`,
      )
      .all(projectId, limit)
      .map(fileOf);
  }

  create(
    projectId: string,
    author: KnowledgeAuthor,
    name: string,
    text: string,
    now: number,
  ): KnowledgeFile {
    const id = newId();
    this.db
      .query(
        `insert into knowledge_files
       (id, project_id, name, kind, text, bytes, lines, digest, tokens,
        revision, author_kind, author_id, author_name, session_id, origin,
        key_name, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        projectId,
        name,
        kindOf(name),
        text,
        ...measure(text),
        author.kind,
        author.id,
        author.name,
        author.sessionId,
        author.origin,
        author.keyName,
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
    this.db
      .query(
        `update knowledge_files set text = ?, bytes = ?, lines = ?, digest = ?,
       tokens = ?, revision = revision + 1, author_kind = ?, author_id = ?,
       author_name = ?, session_id = ?, origin = ?, key_name = ?,
       updated_at = ? where project_id = ? and id = ?`,
      )
      .run(
        text,
        ...measure(text),
        author.kind,
        author.id,
        author.name,
        author.sessionId,
        author.origin,
        author.keyName,
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
    this.db
      .query(
        `update knowledge_files set name = ?, kind = ?,
       revision = revision + 1, author_kind = ?, author_id = ?,
       author_name = ?, session_id = ?, origin = ?, key_name = ?,
       updated_at = ? where project_id = ? and id = ?`,
      )
      .run(
        name,
        kindOf(name),
        author.kind,
        author.id,
        author.name,
        author.sessionId,
        author.origin,
        author.keyName,
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
    this.db
      .query("delete from knowledge_files where project_id = ? and id = ?")
      .run(current.projectId, current.id);
    return file;
  }
}
