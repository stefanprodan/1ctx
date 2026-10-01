// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Repositories a project mounts for bash: the row an admin or a
// personal project's owner writes, and its last fetch. The trees are
// files in the cache, never rows. A credential a repository names
// cannot be deleted under it. A turn's first message keeps the commit
// it mounted of each repository, JSON {repo id: commit}, null before.
export const m0040: Migration = {
  id: "0040-repos",
  up(db) {
    db.exec(`
      create table repos (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        name text not null,
        url text not null,
        kind text not null check (kind in ('github', 'gitlab')),
        ref text not null default '',
        credential_id text references credentials(id),
        ignore_rules text not null default '',
        state text not null default 'pending'
          check (state in ('pending', 'fetching', 'ready', 'failed')),
        error text check (error in ('not found', 'no access',
          'host unreachable', 'over the size cap', 'cache full',
          'fetching')),
        etag text,
        commit_id text,
        fetched_at integer,
        files integer,
        bytes integer,
        ignored integer,
        created_at integer not null,
        updated_at integer not null,
        unique (project_id, name)
      );
      create index repos_credential on repos(credential_id)
        where credential_id is not null;

      alter table messages add column mounted_repos text;
    `);
  },
};
