// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The sandbox shell's one settings row, made here so a save is always
// an update. The instance id is made at its first read and never
// changes: the gateway's own label and every sandbox and provider label
// carry it. It is not made here, so a database built from the
// migrations alone stays the same file byte for byte. Image null is the
// default, the one named after the binary's version, so an upgrade moves
// it along.
export const m0086: Migration = {
  id: "0086-sandbox",
  up(db) {
    db.exec(`
      create table sandbox_settings (
        id integer primary key check (id = 1),
        backend text not null default 'builtin'
          check (backend in ('builtin', 'openshell')),
        endpoint text,
        image text,
        instance_id text,
        updated_at integer not null
      );
      insert into sandbox_settings (id, updated_at) values (1, 0);
    `);
  },
};
