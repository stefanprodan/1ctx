// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// No passwords: an admin signs in with a key file, everyone by email.
// A key login keeps its key's hash, so a changed file ends it; logins
// by email hold null. A user's first sign-in is recorded, so an invite
// goes again only before it, filled from the latest login or visit
// before the logins go; null where neither is left. Every login, link
// and queued link email goes, so nothing from before survives and
// everyone signs in again; the outbox's check keeps the reset kind for
// its history. Neither dropped column is indexed, so no rebuild.
export const m0092: Migration = {
  id: "0092-admin-keys",
  up(db) {
    db.exec(`
      alter table users add column signed_in_at integer;
      update users set signed_in_at = (select max(at) from (
        select max(last_seen_at) as at from logins
          where logins.user_id = users.id
        union all
        select max(at) from visits where visits.user_id = users.id));

      delete from logins;
      delete from user_links;
      delete from email_outbox
        where kind in ('reset', 'signin', 'invite') and status = 'queued';

      alter table logins add column key_digest text;
      create index logins_key on logins(user_id) where key_digest is not null;

      alter table users drop column password_hash;
      alter table users drop column must_change_password;
    `);
  },
};
