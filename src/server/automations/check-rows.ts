// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The check's columns on its automations row, each write in the
// caller's transaction, by key.

import type { CheckResult } from "../../shared/contracts/automation.ts";
import type { Db } from "../db/index.ts";
import { CHECK_HOLDS, openAlertRuns } from "../sessions/index.ts";

// what the answer that started the last run said
export type Validators = {
  etag: string | null;
  lastModified: string | null;
  hash: string | null;
};

export function validators(db: Db, id: string): Validators {
  const row = db
    .query<
      {
        check_etag: string | null;
        check_last_modified: string | null;
        check_body_hash: string | null;
      },
      [string]
    >(
      `select check_etag, check_last_modified, check_body_hash
       from automations where id = ?`,
    )
    .get(id);
  return {
    etag: row?.check_etag ?? null,
    lastModified: row?.check_last_modified ?? null,
    hash: row?.check_body_hash ?? null,
  };
}

// only while the row is unedited: a new URL, even one changed back,
// cleared them. A missed save only repeats a run
export function saveValidators(
  db: Db,
  id: string,
  editRevision: number,
  seen: Validators,
): void {
  db.query(
    `update automations set check_etag = ?, check_last_modified = ?,
       check_body_hash = ? where id = ? and edit_revision = ?`,
  ).run(seen.etag, seen.lastModified, seen.hash, id, editRevision);
}

// the last check; an answer moves the silence's start, a scheduled fire
// moves next_at
export function recordCheck(
  db: Db,
  id: string,
  fields: {
    at: number;
    result: CheckResult;
    answered: boolean;
    nextAt?: number;
  },
): void {
  db.query(
    `update automations set last_checked_at = ?, last_check_result = ?,
       last_answered_at = iif(?, ?, last_answered_at),
       next_at = coalesce(?, next_at),
       revision = revision + 1, updated_at = ? where id = ?`,
  ).run(
    fields.at,
    fields.result,
    fields.answered ? 1 : 0,
    fields.at,
    fields.nextAt ?? null,
    fields.at,
    id,
  );
}

// an answer whose run could not start still clears the check's alert;
// false when the URL changed
export function noteAnswer(
  db: Db,
  id: string,
  url: string,
  at: number,
): boolean {
  const noted =
    db
      .query(
        `update automations set last_answered_at = ?, revision = revision + 1
         where id = ? and check_url = ?`,
      )
      .run(at, id, url).changes > 0;
  if (noted) checkAnswered(db, id);
  return noted;
}

// closes the check's alert unless a marked run belongs to it
export function checkAnswered(db: Db, id: string): void {
  db.query(
    `update automations set check_alert_at = null,
       attention_since = iif(${CHECK_HOLDS} and not exists (
         select 1 ${openAlertRuns("automations")}), null, attention_since)
     where id = ? and check_alert_at is not null`,
  ).run(id);
}

// null while a dismissed check's mark is left
export function checkFailed(
  db: Db,
  id: string,
  at: number,
): "opened" | "joined" | null {
  if (
    db
      .query(
        `update automations set attention_since = ?, check_alert_at = ?
         where id = ? and attention_since is null and check_alert_at is null`,
      )
      .run(at, at, id).changes > 0
  ) {
    return "opened";
  }
  return db
    .query(
      `update automations set check_alert_at = ?
       where id = ? and attention_since is not null`,
    )
    .run(at, id).changes > 0
    ? "joined"
    : null;
}
