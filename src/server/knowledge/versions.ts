// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Immutable post-images and deletion records whose lifetime exceeds the
// live file's. Eviction bounds history without blocking writes; age alone
// expires only deleted-file history so live versions remain restorable.

import type {
  KnowledgeDeleted,
  KnowledgeFile,
  KnowledgeVersion,
  KnowledgeVersionDetail,
} from "../../shared/contracts/knowledge.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import {
  authorOf,
  VERSION_COLUMNS,
  type VersionRaw,
  versionOf,
} from "./rows.ts";

export class KnowledgeVersions {
  constructor(private readonly db: Db) {}

  versions(projectId: string, fileId: string): KnowledgeVersion[] {
    return this.db
      .query<VersionRaw, [string, string]>(
        `select ${VERSION_COLUMNS} from knowledge_versions
       where project_id = ? and file_id = ? order by revision desc`,
      )
      .all(projectId, fileId)
      .map(versionOf);
  }

  version(projectId: string, id: string): KnowledgeVersionDetail | null {
    const raw = this.db
      .query<VersionRaw & { text: string }, [string, string]>(
        `select ${VERSION_COLUMNS}, text from knowledge_versions
       where project_id = ? and id = ?`,
      )
      .get(projectId, id);
    return raw === null ? null : { ...versionOf(raw), text: raw.text };
  }

  deleted(projectId: string): KnowledgeDeleted[] {
    return this.db
      .query<VersionRaw & { file_snapshot: string }, [string]>(
        `select ${VERSION_COLUMNS}, file_snapshot from knowledge_versions
       where project_id = ? and deleted = 1
       order by written_at desc, rowid desc`,
      )
      .all(projectId)
      .map((raw) => ({
        ...(JSON.parse(raw.file_snapshot) as KnowledgeFile),
        deletedBy: authorOf(raw),
        deletedAt: raw.written_at,
      }));
  }

  insert(
    file: KnowledgeFile,
    text: string,
    deleted: boolean,
    snapshot: KnowledgeFile | null = null,
  ): void {
    this.db
      .query(
        `insert into knowledge_versions
       (id, file_id, project_id, name, revision, text, bytes, lines,
        author_kind, author_id, author_name, session_id, origin, written_at,
        deleted, file_snapshot)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        file.id,
        file.projectId,
        file.name,
        file.revision,
        text,
        deleted ? 0 : file.bytes,
        deleted ? 0 : file.lines,
        file.author.kind,
        file.author.id,
        file.author.name,
        file.author.sessionId,
        file.author.origin,
        file.updatedAt,
        deleted ? 1 : 0,
        snapshot === null ? null : JSON.stringify(snapshot),
      );
  }

  evict(
    projectId: string,
    fileIds: readonly string[],
    caps: KnowledgeCaps,
  ): void {
    for (const fileId of fileIds) {
      this.db
        .query(
          `delete from knowledge_versions where project_id = ? and file_id = ?
         and id not in (
           select id from knowledge_versions where project_id = ? and file_id = ?
           order by revision desc limit ?
         )`,
        )
        .run(projectId, fileId, projectId, fileId, caps.knowledgeVersions);
    }
    this.db
      .query(
        `delete from knowledge_versions where rowid in (
         select rowid from (
           select rowid, sum(bytes) over (
             order by written_at desc, rowid desc
             rows between unbounded preceding and current row
           ) as retained from knowledge_versions where project_id = ?
         ) where retained > ?
       )`,
      )
      .run(projectId, caps.knowledgeHistoryBytes);
  }

  sweep(now: number, days: number): number {
    return this.db
      .query(
        `delete from knowledge_versions where file_id in (
         select file_id from knowledge_versions where deleted = 1
         and written_at < ?
       ) and not exists (
         select 1 from knowledge_files where id = knowledge_versions.file_id
       )`,
      )
      .run(now - days * 86_400_000).changes;
  }
}
