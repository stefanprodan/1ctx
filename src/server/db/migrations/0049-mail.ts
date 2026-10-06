// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The instance's SMTP server, one row whose password is a key file it
// names, and the outbox every mail goes through: written in the
// transaction that causes it, taken by the sender, deleted once sent.
// A failed row keeps its kind, user, word and times, never the text.
// The kinds are every mail the instance will send, and a row may be
// kept as sent for a cap counted on rows, so neither needs a rebuild.
// An email made from the username on the placeholder domain was never
// a real address, so it is marked and never mailed.
export const m0049: Migration = {
  id: "0049-mail",
  up(db) {
    db.exec(`
      create table mail_settings (
        id integer primary key check (id = 1),
        host text not null,
        port integer not null check (port between 1 and 65535),
        security text not null check (security in ('tls', 'starttls')),
        username text,
        key_name text,
        from_address text not null,
        from_name text not null default '1ctx',
        public_address text not null,
        updated_at integer not null
      );

      create table mail_outbox (
        id text primary key,
        kind text not null check (kind in ('reset', 'signin', 'invite',
          'notice', 'agent', 'alert')),
        user_id text not null references users(id) on delete cascade,
        project_id text references projects(id) on delete cascade,
        session_id text references sessions(id) on delete cascade,
        subject text,
        body text,
        message_id text not null unique,
        status text not null default 'queued'
          check (status in ('queued', 'sent', 'failed')),
        attempts integer not null default 0,
        next_attempt_at integer not null,
        claimed_at integer,
        failure text check (failure in ('auth', 'tls', 'connect',
          'rejected', 'timeout', 'other')),
        created_at integer not null,
        updated_at integer not null
      );
      create index mail_outbox_due on mail_outbox(status, next_attempt_at);
      create index mail_outbox_project on mail_outbox(project_id, created_at)
        where project_id is not null;

      alter table users add column email_placeholder integer not null
        default 0 check (email_placeholder in (0, 1));
      update users set email_placeholder = 1
        where email = username || '@1ctx.dev';
    `);
  },
};
