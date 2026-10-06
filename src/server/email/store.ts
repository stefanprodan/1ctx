// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PutSmtpRequest } from "../../shared/api/smtp.ts";
import type {
  SmtpFailure,
  SmtpSecurity,
  SmtpSettings,
} from "../../shared/contracts/smtp.ts";
import { type Db, transact } from "../db/index.ts";
import type { EmailKind } from "./rules.ts";

export type OutboxRow = {
  id: string;
  kind: EmailKind;
  userId: string;
  projectId: string | null;
  sessionId: string | null;
  subject: string | null;
  body: string | null;
  messageId: string;
  attempts: number;
  createdAt: number;
};

// automationId names an alert's automation, for its cap; asked marks a
// link email asked for at the sign-in page, for the caps on asks
export type OutboxFields = Omit<OutboxRow, "attempts"> & {
  automationId: string | null;
  asked: boolean;
  now: number;
};

export type OutboxCounts = {
  queued: number;
  failed: number;
  // the newest failed row's word and when it failed
  lastFailure: SmtpFailure | null;
  lastFailedAt: number | null;
};

type RawSettings = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  key_name: string | null;
  from_address: string;
  from_name: string;
  public_address: string;
  updated_at: number;
};

type RawOutbox = {
  id: string;
  kind: EmailKind;
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

export class EmailStore {
  constructor(private readonly db: Db) {}

  settings(): SmtpSettings | null {
    const raw = this.db
      .query<RawSettings, []>("select * from smtp_settings where id = 1")
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

  saveSettings(fields: PutSmtpRequest, now: number): void {
    this.db
      .query(
        `insert into smtp_settings (id, host, port, security, username,
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
        `insert into email_outbox (id, kind, user_id, project_id, session_id,
           automation_id, subject, body, message_id, asked, next_attempt_at,
           created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.id,
        fields.kind,
        fields.userId,
        fields.projectId,
        fields.sessionId,
        fields.automationId,
        fields.subject,
        fields.body,
        fields.messageId,
        fields.asked ? 1 : 0,
        fields.now,
        fields.createdAt,
        fields.now,
      );
  }

  byId(id: string): OutboxRow | null {
    const raw = this.db
      .query<RawOutbox, [string]>("select * from email_outbox where id = ?")
      .get(id);
    return raw === null ? null : outbox(raw);
  }

  // the oldest due row, claimed as of now; a claim older than stale is
  // a dead process's and taken again
  claim(now: number, stale: number): OutboxRow | null {
    return transact(this.db, () => {
      const raw = this.db
        .query<RawOutbox, [number, number]>(
          `select * from email_outbox
           where status = 'queued' and next_attempt_at <= ?
             and (claimed_at is null or claimed_at <= ?)
           order by next_attempt_at, created_at limit 1`,
        )
        .get(now, now - stale);
      if (raw === null) return { result: null };
      this.db
        .query("update email_outbox set claimed_at = ? where id = ?")
        .run(now, raw.id);
      return { result: outbox(raw) };
    });
  }

  // dropped: nothing of it is kept, but an asked row stays a day as
  // dropped, with no text, so the caps on asks keep counting it
  drop(id: string, now: number): void {
    transact(this.db, () => {
      this.db
        .query(
          `update email_outbox set status = 'dropped', subject = null,
             body = null, claimed_at = null, updated_at = ?
           where id = ? and asked = 1`,
        )
        .run(now, id);
      this.db
        .query("delete from email_outbox where id = ? and asked = 0")
        .run(id);
      return { result: undefined };
    });
  }

  // a user's queued rows of these kinds, as when the links they would
  // carry are revoked, dropped as drop() does; the count dropped
  dropQueued(userId: string, kinds: readonly EmailKind[], now: number): number {
    if (kinds.length === 0) return 0;
    const where = `user_id = ? and status = 'queued'
      and kind in (${kinds.map(() => "?").join(", ")})`;
    const kept = this.db
      .query(
        `update email_outbox set status = 'dropped', subject = null,
           body = null, claimed_at = null, updated_at = ?
         where ${where} and asked = 1`,
      )
      .run(now, userId, ...kinds).changes;
    const removed = this.db
      .query(`delete from email_outbox where ${where} and asked = 0`)
      .run(userId, ...kinds).changes;
    return kept + removed;
  }

  // whether the user has a queued row of the kind, as a link email
  // still being tried
  hasQueued(userId: string, kind: EmailKind): boolean {
    return (
      this.db
        .query<{ n: number }, [string, string]>(
          `select count(*) as n from email_outbox
           where user_id = ? and kind = ? and status = 'queued'`,
        )
        .get(userId, kind)!.n > 0
    );
  }

  // the text goes; the row stays a day for the caps counted on rows
  sent(id: string, now: number): void {
    this.db
      .query(
        `update email_outbox set status = 'sent', subject = null, body = null,
           claimed_at = null, updated_at = ? where id = ?`,
      )
      .run(now, id);
  }

  retry(id: string, attempts: number, at: number, now: number): void {
    this.db
      .query(
        `update email_outbox set attempts = ?, next_attempt_at = ?,
           claimed_at = null, updated_at = ? where id = ?`,
      )
      .run(attempts, at, now, id);
  }

  // the text goes; the kind, the user, the word and the times stay
  fail(id: string, attempts: number, failure: SmtpFailure, now: number): void {
    this.db
      .query(
        `update email_outbox set status = 'failed', attempts = ?,
           failure = ?, subject = null, body = null, claimed_at = null,
           updated_at = ? where id = ?`,
      )
      .run(attempts, failure, now, id);
  }

  // the rows of a kind written for a session at or after since, sent,
  // failed or queued: a cap per send
  countSession(sessionId: string, kind: EmailKind, since: number): number {
    return this.db
      .query<{ n: number }, [string, string, number]>(
        `select count(*) as n from email_outbox
         where session_id = ? and kind = ? and created_at >= ?`,
      )
      .get(sessionId, kind, since)!.n;
  }

  // the same for a project: a cap per day
  countProject(projectId: string, kind: EmailKind, since: number): number {
    return this.db
      .query<{ n: number }, [string, string, number]>(
        `select count(*) as n from email_outbox
         where project_id = ? and kind = ? and created_at >= ?`,
      )
      .get(projectId, kind, since)!.n;
  }

  // an automation's alert rows at or after since; only an alert row
  // names its automation, which a deleted run leaves in place
  countAlerts(automationId: string, since: number): number {
    return this.db
      .query<{ n: number }, [string, number]>(
        `select count(*) as n from email_outbox
         where automation_id = ? and created_at >= ?`,
      )
      .get(automationId, since)!.n;
  }

  // the link emails asked for at the sign-in page at or after since, a
  // user's or, with null, the instance's
  countAsked(userId: string | null, since: number): number {
    return userId === null
      ? this.db
          .query<{ n: number }, [number]>(
            `select count(*) as n from email_outbox
             where asked = 1 and created_at >= ?`,
          )
          .get(since)!.n
      : this.db
          .query<{ n: number }, [string, number]>(
            `select count(*) as n from email_outbox
             where asked = 1 and user_id = ? and created_at >= ?`,
          )
          .get(userId, since)!.n;
  }

  // the next time a row is due, a claimed one aside
  earliest(): number | null {
    return this.db
      .query<{ at: number | null }, []>(
        `select min(next_attempt_at) as at from email_outbox
         where status = 'queued' and claimed_at is null`,
      )
      .get()!.at;
  }

  // sent and dropped rows past sentBefore, failed ones past failedBefore
  sweep(sentBefore: number, failedBefore: number): number {
    return this.db
      .query(
        `delete from email_outbox
         where (status in ('sent', 'dropped') and updated_at < ?)
           or (status = 'failed' and updated_at < ?)`,
      )
      .run(sentBefore, failedBefore).changes;
  }

  counts(): OutboxCounts {
    const tally = this.db
      .query<{ queued: number | null; failed: number | null }, []>(
        `select sum(status = 'queued') as queued,
           sum(status = 'failed') as failed from email_outbox`,
      )
      .get()!;
    const last = this.db
      .query<{ failure: SmtpFailure; updated_at: number }, []>(
        `select failure, updated_at from email_outbox where status = 'failed'
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
