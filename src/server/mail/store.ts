// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PutMailRequest } from "../../shared/api/mail.ts";
import type {
  MailFailure,
  MailSecurity,
  MailSettings,
} from "../../shared/contracts/mail.ts";
import { type Db, transact } from "../db/index.ts";
import type { MailKind } from "./rules.ts";

export type OutboxRow = {
  id: string;
  kind: MailKind;
  userId: string;
  projectId: string | null;
  sessionId: string | null;
  subject: string | null;
  body: string | null;
  messageId: string;
  attempts: number;
  createdAt: number;
};

export type OutboxFields = Omit<OutboxRow, "attempts"> & { now: number };

export type OutboxCounts = {
  queued: number;
  failed: number;
  // the newest failed row's word and when it failed
  lastFailure: MailFailure | null;
  lastFailedAt: number | null;
};

type RawSettings = {
  host: string;
  port: number;
  security: MailSecurity;
  username: string | null;
  key_name: string | null;
  from_address: string;
  from_name: string;
  public_address: string;
  updated_at: number;
};

type RawOutbox = {
  id: string;
  kind: MailKind;
  user_id: string;
  project_id: string | null;
  session_id: string | null;
  subject: string | null;
  body: string | null;
  message_id: string;
  attempts: number;
  created_at: number;
};

const outbox = (raw: RawOutbox): OutboxRow => ({
  id: raw.id,
  kind: raw.kind,
  userId: raw.user_id,
  projectId: raw.project_id,
  sessionId: raw.session_id,
  subject: raw.subject,
  body: raw.body,
  messageId: raw.message_id,
  attempts: raw.attempts,
  createdAt: raw.created_at,
});

export class MailStore {
  constructor(private readonly db: Db) {}

  settings(): MailSettings | null {
    const raw = this.db
      .query<RawSettings, []>("select * from mail_settings where id = 1")
      .get();
    if (raw === null) return null;
    return {
      host: raw.host,
      port: raw.port,
      security: raw.security,
      username: raw.username,
      keyName: raw.key_name,
      fromAddress: raw.from_address,
      fromName: raw.from_name,
      publicAddress: raw.public_address,
      updatedAt: raw.updated_at,
    };
  }

  saveSettings(fields: PutMailRequest, now: number): void {
    this.db
      .query(
        `insert into mail_settings (id, host, port, security, username,
           key_name, from_address, from_name, public_address, updated_at)
         values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set
           host = excluded.host,
           port = excluded.port,
           security = excluded.security,
           username = excluded.username,
           key_name = excluded.key_name,
           from_address = excluded.from_address,
           from_name = excluded.from_name,
           public_address = excluded.public_address,
           updated_at = excluded.updated_at`,
      )
      .run(
        fields.host,
        fields.port,
        fields.security,
        fields.username,
        fields.keyName,
        fields.fromAddress,
        fields.fromName,
        fields.publicAddress,
        now,
      );
  }

  insert(fields: OutboxFields): void {
    this.db
      .query(
        `insert into mail_outbox (id, kind, user_id, project_id, session_id,
           subject, body, message_id, next_attempt_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.id,
        fields.kind,
        fields.userId,
        fields.projectId,
        fields.sessionId,
        fields.subject,
        fields.body,
        fields.messageId,
        fields.now,
        fields.createdAt,
        fields.now,
      );
  }

  byId(id: string): OutboxRow | null {
    const raw = this.db
      .query<RawOutbox, [string]>("select * from mail_outbox where id = ?")
      .get(id);
    return raw === null ? null : outbox(raw);
  }

  // the oldest due row, claimed as of now; a claim older than stale is
  // a dead process's and taken again
  claim(now: number, stale: number): OutboxRow | null {
    return transact(this.db, () => {
      const raw = this.db
        .query<RawOutbox, [number, number]>(
          `select * from mail_outbox
           where status = 'queued' and next_attempt_at <= ?
             and (claimed_at is null or claimed_at <= ?)
           order by next_attempt_at, created_at limit 1`,
        )
        .get(now, now - stale);
      if (raw === null) return { result: null };
      this.db
        .query("update mail_outbox set claimed_at = ? where id = ?")
        .run(now, raw.id);
      return { result: outbox(raw) };
    });
  }

  // sent or dropped: nothing of it is kept
  remove(id: string): void {
    this.db.query("delete from mail_outbox where id = ?").run(id);
  }

  retry(id: string, attempts: number, at: number, now: number): void {
    this.db
      .query(
        `update mail_outbox set attempts = ?, next_attempt_at = ?,
           claimed_at = null, updated_at = ? where id = ?`,
      )
      .run(attempts, at, now, id);
  }

  // the text goes; the kind, the user, the word and the times stay
  fail(id: string, attempts: number, failure: MailFailure, now: number): void {
    this.db
      .query(
        `update mail_outbox set status = 'failed', attempts = ?,
           failure = ?, subject = null, body = null, claimed_at = null,
           updated_at = ? where id = ?`,
      )
      .run(attempts, failure, now, id);
  }

  // the next time a row is due, a claimed one aside
  earliest(): number | null {
    return this.db
      .query<{ at: number | null }, []>(
        `select min(next_attempt_at) as at from mail_outbox
         where status = 'queued' and claimed_at is null`,
      )
      .get()!.at;
  }

  sweep(before: number): number {
    return this.db
      .query(
        "delete from mail_outbox where status = 'failed' and updated_at < ?",
      )
      .run(before).changes;
  }

  counts(): OutboxCounts {
    const tally = this.db
      .query<{ queued: number | null; failed: number | null }, []>(
        `select sum(status = 'queued') as queued,
           sum(status = 'failed') as failed from mail_outbox`,
      )
      .get()!;
    const last = this.db
      .query<{ failure: MailFailure; updated_at: number }, []>(
        `select failure, updated_at from mail_outbox where status = 'failed'
         order by updated_at desc limit 1`,
      )
      .get();
    return {
      queued: tally.queued ?? 0,
      failed: tally.failed ?? 0,
      lastFailure: last?.failure ?? null,
      lastFailedAt: last?.updated_at ?? null,
    };
  }
}
