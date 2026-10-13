// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { newId } from "../../lib/ids.ts";
import type { Migration } from "../migration.ts";

// The four every project starts with, written out here so a later change
// to the defaults never changes what this migration did.
const FOUR = [
  ["research", "Investigation or analysis, no change made"],
  ["plan", "A proposal or design to decide on"],
  ["build", "New work or a change to existing work"],
  ["fix", "A defect or failure to correct"],
] as const;

// A project's labels, unique by name within it and gone with it. Links
// will name the id, so a rename keeps them. Every project held gets the
// four, dated with the project.
export const m0067: Migration = {
  id: "0067-project-labels",
  up(db) {
    db.exec(`
      create table project_labels (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        name text not null
          check (length(name) between 1 and 24
            and name not glob '*[^a-z0-9-]*' and name not glob '-*'),
        description text not null default '',
        created_at integer not null,
        unique (project_id, name)
      );
    `);
    const insert = db.query(
      `insert into project_labels (id, project_id, name, description, created_at)
        values (?, ?, ?, ?, ?)`,
    );
    const projects = db
      .query<{ id: string; created_at: number }, []>(
        "select id, created_at from projects",
      )
      .all();
    for (const project of projects) {
      for (const [name, description] of FOUR) {
        insert.run(newId(), project.id, name, description, project.created_at);
      }
    }
  },
};
