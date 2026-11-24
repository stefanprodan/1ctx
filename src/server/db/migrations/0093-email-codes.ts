// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A link email carries a code beside its link. Every ask makes a new
// link, so only an unused invite stays one per user; a link keeps its
// code's hash, the wrong tries and the hash of the asking browser's
// challenge, and the outbox row names its link, by which the send mints
// both. The caps count asks in link_asks, kept a day whatever became of
// their links, so the outbox's asked mark and its indexes go. No row
// from before 0092 survives, so nothing is backfilled. The outbox's
// link_id has no foreign key: a revoked link's row reads as revoked.
export const m0093: Migration = {
  id: "0093-email-codes",
  up(db) {
    db.exec(`
      alter table user_links add column code_hash text;
      alter table user_links add column code_tries integer not null
        default 0;
      alter table user_links add column ask_hash text;
      drop index user_links_unused;
      create unique index user_links_invite on user_links(user_id)
        where purpose = 'invite' and used_at is null;
      create index user_links_user on user_links(user_id, ask_hash);

      alter table email_outbox add column link_id text;
      drop index email_outbox_asked;
      drop index email_outbox_asked_at;
      alter table email_outbox drop column asked;

      create table link_asks (
        id integer primary key,
        user_id text references users(id) on delete set null,
        challenge_hash text not null,
        asked_at integer not null
      );
      create index link_asks_time on link_asks(asked_at);
      create index link_asks_user
        on link_asks(user_id, challenge_hash, asked_at);
      create index link_asks_challenge on link_asks(challenge_hash, asked_at);
    `);
  },
};
