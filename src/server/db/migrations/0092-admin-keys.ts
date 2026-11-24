// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// No passwords: an admin signs in with a key file, everyone by email.
// A key login keeps its key's hash, so a changed file ends it; logins
// by email hold null. A user's first sign-in is recorded, so an invite
// goes again only before it, filled from the latest login or visit.
// Dropping the forced change would widen a must-change user's logins
// and access keys, so both go first; the start's sweep ends those keys'
// external task claims, as for any key gone. Reset links and their
// queued emails go; the outbox's check keeps the kind for its history.
// Neither dropped column is indexed, so no rebuild.
export const m0092: Migration = {
  id: "0092-admin-keys",
  up(db) {
    db.exec(`
      delete from logins where user_id in
        (select id from users where must_change_password = 1);
      delete from access_keys where user_id in
        (select id from users where must_change_password = 1);
      delete from user_links where purpose = 'reset';
      delete from email_outbox where kind = 'reset' and status = 'queued';

      alter table logins add column key_digest text;
      create index logins_key on logins(user_id) where key_digest is not null;

      alter table users add column signed_in_at integer;
      update users set signed_in_at = nullif(max(
        coalesce((select max(last_seen_at) from logins
          where logins.user_id = users.id), 0),
        coalesce((select max(at) from visits
          where visits.user_id = users.id), 0)), 0);

      alter table users drop column password_hash;
      alter table users drop column must_change_password;
    `);
  },
};
