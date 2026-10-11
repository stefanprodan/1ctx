// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A write over an access key is the key's user with origin key, its
// name copied to the file and the version so history outlives the key.
// Widening the checks rebuilds both tables in place, every row copied
// with its rowid, since a tie on time sorts by it.
export const m0060: Migration = {
  id: "0060-knowledge-keys",
  rebuild: true,
  rebuilds: ["knowledge_files", "knowledge_versions"],
  up(db) {
    db.exec(`
      create table knowledge_files_new (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        name text not null,
        kind text not null,
        text text not null,
        bytes integer not null,
        lines integer not null,
        digest text not null,
        tokens integer not null,
        revision integer not null,
        author_kind text not null check (author_kind in ('user', 'agent')),
        author_id text not null,
        author_name text not null,
        session_id text,
        origin text check (origin in ('chat', 'automation', 'key')),
        created_at integer not null,
        updated_at integer not null,
        key_name text,
        unique (project_id, name)
      );
      insert into knowledge_files_new
        (rowid, id, project_id, name, kind, text, bytes, lines, digest,
         tokens, revision, author_kind, author_id, author_name, session_id,
         origin, created_at, updated_at)
      select rowid, id, project_id, name, kind, text, bytes, lines, digest,
        tokens, revision, author_kind, author_id, author_name, session_id,
        origin, created_at, updated_at
      from knowledge_files;
      drop table knowledge_files;
      alter table knowledge_files_new rename to knowledge_files;

      create table knowledge_versions_new (
        id text primary key,
        file_id text not null,
        project_id text not null references projects(id) on delete cascade,
        name text not null,
        revision integer not null,
        text text not null,
        bytes integer not null,
        lines integer not null,
        author_kind text not null check (author_kind in ('user', 'agent')),
        author_id text not null,
        author_name text not null,
        session_id text,
        origin text check (origin in ('chat', 'automation', 'key')),
        written_at integer not null,
        deleted integer not null check (deleted in (0, 1)),
        file_snapshot text,
        key_name text
      );
      insert into knowledge_versions_new
        (rowid, id, file_id, project_id, name, revision, text, bytes, lines,
         author_kind, author_id, author_name, session_id, origin, written_at,
         deleted, file_snapshot)
      select rowid, id, file_id, project_id, name, revision, text, bytes,
        lines, author_kind, author_id, author_name, session_id, origin,
        written_at, deleted, file_snapshot
      from knowledge_versions;
      drop table knowledge_versions;
      alter table knowledge_versions_new rename to knowledge_versions;
      create index knowledge_versions_file
        on knowledge_versions(file_id, revision);
      create index knowledge_versions_project
        on knowledge_versions(project_id, written_at);
    `);
  },
};
