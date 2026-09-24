// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// HTTP credentials: a key file's name, the https prefix curl signs with
// it and the header it goes in, bound to team projects. A link goes
// with its credential and with its project.
export const m0022: Migration = {
  id: "0022-credentials",
  up(db) {
    db.exec(`
      create table credentials (
        id text primary key,
        name text not null unique,
        key_name text not null,
        prefix text not null,
        header text not null,
        template text not null,
        methods text not null,
        created_at integer not null,
        updated_at integer not null
      );

      create table credential_projects (
        credential_id text not null
          references credentials(id) on delete cascade,
        project_id text not null references projects(id) on delete cascade,
        primary key (credential_id, project_id)
      );
      create index credential_projects_project
        on credential_projects(project_id);
    `);
  },
};
