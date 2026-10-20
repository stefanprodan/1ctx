// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Knowledge writes accept a channel origin. Mutable bash state is keyed by
// workspace, and a send mark records that its tool rows were aged to traces.
export const m0073: Migration = {
  id: "0073-channel-workspaces",
  rebuild: true,
  rebuilds: [
    "knowledge_files",
    "knowledge_versions",
    "session_scratch",
    "session_scratch_files",
  ],
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
        origin text check (origin in ('chat', 'automation', 'channel', 'key')),
        created_at integer not null,
        updated_at integer not null,
        key_name text,
        unique (project_id, name)
      );
      insert into knowledge_files_new
        (rowid, id, project_id, name, kind, text, bytes, lines, digest,
         tokens, revision, author_kind, author_id, author_name, session_id,
         origin, created_at, updated_at, key_name)
      select rowid, id, project_id, name, kind, text, bytes, lines, digest,
        tokens, revision, author_kind, author_id, author_name, session_id,
        origin, created_at, updated_at, key_name
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
        origin text check (origin in ('chat', 'automation', 'channel', 'key')),
        written_at integer not null,
        deleted integer not null check (deleted in (0, 1)),
        file_snapshot text,
        key_name text
      );
      insert into knowledge_versions_new
        (rowid, id, file_id, project_id, name, revision, text, bytes, lines,
         author_kind, author_id, author_name, session_id, origin, written_at,
         deleted, file_snapshot, key_name)
      select rowid, id, file_id, project_id, name, revision, text, bytes,
        lines, author_kind, author_id, author_name, session_id, origin,
        written_at, deleted, file_snapshot, key_name
      from knowledge_versions;
      drop table knowledge_versions;
      alter table knowledge_versions_new rename to knowledge_versions;
      create index knowledge_versions_file
        on knowledge_versions(file_id, revision);
      create index knowledge_versions_project
        on knowledge_versions(project_id, written_at);

      create table session_scratch_new (
        workspace_id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        cwd text not null,
        revision integer not null,
        bytes integer not null,
        files integer not null,
        used_at integer not null
      );
      insert into session_scratch_new
        (workspace_id, session_id, cwd, revision, bytes, files, used_at)
      select session_id, session_id, cwd, revision, bytes, files, used_at
      from session_scratch;
      create temp table scratch_files_copy as
        select session_id as workspace_id, path, data, mode
        from session_scratch_files;
      drop table session_scratch_files;
      drop table session_scratch;
      alter table session_scratch_new rename to session_scratch;
      create table session_scratch_files (
        workspace_id text not null references session_scratch(workspace_id)
          on delete cascade,
        path text not null,
        data blob not null,
        mode integer not null,
        primary key (workspace_id, path)
      );
      insert into session_scratch_files
        (workspace_id, path, data, mode)
      select workspace_id, path, data, mode from scratch_files_copy;
      drop table scratch_files_copy;
      create index session_scratch_session on session_scratch(session_id);
      create index session_scratch_used on session_scratch(used_at);

      alter table mcp_kept_files add column workspace_id text;

      alter table sends add column swept integer check (swept in (0, 1));
      create index sends_channel_unswept
        on sends(session_id, finished_at, id)
        where swept = 0;
    `);
  },
};
