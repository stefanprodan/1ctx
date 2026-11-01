// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A queued message names its images in order, as it names its uploads,
// so a start reads them from the row it already holds; the image rows
// stay held by queued_id. An image is held by a queued message or sent
// with a message, never both: a check would rebuild a table of bytes,
// so two triggers hold it.
//
// images_budget is rebuilt to cover the budget: a partial index's own
// terms are checked against the table unless the index holds them, so
// the old one read each row's record for data is not null. With
// message_id and that expression in it, the budget's sum and walk never
// touch the table. An added column, triggers and one index; no row
// moves.
export const m0082: Migration = {
  id: "0082-queued-images",
  up(db) {
    db.exec(`
      alter table queued_messages add column images text;
      create trigger images_held_or_sent_insert before insert on images
        when new.queued_id is not null and new.message_id is not null
        begin select raise(abort, 'an image is held or sent, never both'); end;
      create trigger images_held_or_sent_update
        before update of queued_id, message_id on images
        when new.queued_id is not null and new.message_id is not null
        begin select raise(abort, 'an image is held or sent, never both'); end;
      drop index images_budget;
      create index images_budget
        on images(project_id, created_at, bytes, message_id, (data is not null))
        where message_id is not null and data is not null;
    `);
  },
};
