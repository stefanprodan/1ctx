// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The instance's SMTP server, one row whose password is a key file it
// names, and the outbox every email goes through: written in the
// transaction that causes it and taken by the sender. A sent row keeps
// its kind, user, project and times for a day, so a daily cap counts
// it, and a failed one its word for a week; neither keeps the text.
// The kinds are every email the instance will send, so a later one
// needs no rebuild. A chat's delete leaves its sent rows to the cap.
// An alert row names its automation, so deleting runs keeps the
// automation's cap; the automation's own delete takes them, as no cap
// is left to count. A link email asked for at the sign-in page is
// marked, for the caps on asks.
// An address on the project's own domain is a seeded one, never a
// inbox, so it is marked and never emailed.
export const m0049: Migration = {
  id: "0049-email",
  up(db) {
    db.exec(`
      create table smtp_settings (
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

      create table email_outbox (
        id text primary key,
        kind text not null check (kind in ('reset', 'signin', 'invite',
          'notice', 'agent', 'alert')),
        user_id text not null references users(id) on delete cascade,
        project_id text references projects(id) on delete cascade,
        session_id text references sessions(id) on delete set null,
        automation_id text references automations(id) on delete cascade,
        subject text,
        body text,
        message_id text not null unique,
        asked integer not null default 0 check (asked in (0, 1)),
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
      create index email_outbox_due
        on email_outbox(status, next_attempt_at, created_at);
      create index email_outbox_queued on email_outbox(user_id, kind)
        where status = 'queued';
      create index email_outbox_automation
        on email_outbox(automation_id, created_at)
        where automation_id is not null;
      create index email_outbox_asked on email_outbox(user_id, created_at)
        where asked = 1;
      create index email_outbox_asked_at on email_outbox(created_at)
        where asked = 1;
      create index email_outbox_project on email_outbox(project_id, created_at)
        where project_id is not null;
      create index email_outbox_session on email_outbox(session_id, created_at)
        where session_id is not null;

      alter table users add column email_placeholder integer not null
        default 0 check (email_placeholder in (0, 1));
      update users set email_placeholder = 1
        where substr(email, instr(email, '@') + 1) = '1ctx.dev';
    `);
  },
};
