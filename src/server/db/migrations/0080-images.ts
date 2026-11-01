// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// An image a user adds to a chat message: only ingest's output is kept,
// its bytes in the row so they commit and cascade with it. Staged, it
// is its uploader's with a lease and no session or message; sent, it
// takes both and drops the lease; a queued message holds it by its id,
// with no lease. A row has a lease exactly when it is staged.
// A freed image keeps its row and loses its data. The media type has no
// check: a later type widens it in code, never by rebuilding a table of
// bytes. data is the last column, so a read of the others never steps
// into its overflow pages.
//
// The project, session, message and queued indexes serve the cascades;
// the message's serves its images in order too. The user's covers the
// images not sent: a user's live leases for the staged count, and the
// Storage monitor's staged bytes and additions. The expiry's serves the
// lease sweep. The budget's covers a project's sent images that still
// have bytes, oldest first, with their sizes, message_id and (data is
// not null): a partial index's own terms are checked against the table
// unless the index holds them, so without those two each budget read
// would touch every row's record. Its session_id gives the monitor a
// chat's sent bytes from it too.
//
// A queued message holds its images by queued_id, never as a sent one
// too, and names them in order in queued_messages.images, as it names
// its uploads, so a start reads them from the row it holds.
//
// image_uploads logs each accepted upload for the hourly rate, which a
// delete of the image cannot reset; the sweep drops rows past the hour.
export const m0080: Migration = {
  id: "0080-images",
  up(db) {
    db.exec(`
      create table images (
        id text primary key,
        project_id text not null references projects(id) on delete cascade,
        user_id text not null references users(id),
        session_id text references sessions(id) on delete cascade,
        message_id text references messages(id) on delete cascade
          check ((message_id is null) = (session_id is null)),
        queued_id text references queued_messages(id) on delete cascade
          check (queued_id is null or message_id is null),
        position integer not null default 0 check (position >= 0),
        name text not null,
        media_type text not null,
        bytes integer not null check (bytes > 0),
        width integer not null check (width > 0),
        height integer not null check (height > 0),
        digest text not null,
        created_at integer not null,
        expires_at integer
          check ((expires_at is null) =
            (message_id is not null or queued_id is not null)),
        data blob check (data is not null or message_id is not null)
      );
      create index images_project on images(project_id);
      create index images_session on images(session_id)
        where session_id is not null;
      create index images_message on images(message_id, position)
        where message_id is not null;
      create index images_queued on images(queued_id)
        where queued_id is not null;
      create index images_user
        on images(user_id, expires_at, created_at, bytes, message_id)
        where message_id is null;
      create index images_expiry on images(expires_at)
        where expires_at is not null;
      create index images_budget
        on images(project_id, created_at, bytes, message_id, session_id,
          (data is not null))
        where message_id is not null and data is not null;
      alter table queued_messages add column images text;

      create table image_uploads (
        user_id text not null references users(id),
        created_at integer not null
      );
      create index image_uploads_user on image_uploads(user_id, created_at);
      create index image_uploads_created on image_uploads(created_at);
    `);
  },
};
