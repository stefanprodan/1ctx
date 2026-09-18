// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

export const m0015: Migration = {
  id: "0015-knowledge",
  up(db) {
    db.exec(`
      create table knowledge_files (
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
        origin text check (origin in ('chat', 'automation')),
        created_at integer not null,
        updated_at integer not null,
        unique (project_id, name)
      );
      create table knowledge_versions (
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
        origin text check (origin in ('chat', 'automation')),
        written_at integer not null,
        deleted integer not null check (deleted in (0, 1)),
        file_snapshot text
      );
      create index knowledge_versions_file
        on knowledge_versions(file_id, revision);
      create index knowledge_versions_project
        on knowledge_versions(project_id, written_at);
      create table session_scratch (
        session_id text primary key references sessions(id) on delete cascade,
        cwd text not null,
        revision integer not null,
        bytes integer not null,
        files integer not null,
        used_at integer not null
      );
      create table session_scratch_files (
        session_id text not null references session_scratch(session_id) on delete cascade,
        path text not null,
        data blob not null,
        mode integer not null,
        primary key (session_id, path)
      );
      create index session_scratch_used on session_scratch(used_at);
    `);
  },
};
