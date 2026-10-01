// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The days a user was signed in and used the app, one row per day in
// their own zone with the day's first instant: a person's page counts
// each as one action. A login lasts a month and slides, so a password
// sign-in says little about a day; a signed-in request does.

import type { Db } from "../db/index.ts";
import { DAY_MS } from "../lib/clock.ts";

// past the widest window, so a heatmap never loses a visit it shows
export const VISIT_RETENTION_MS = 400 * DAY_MS;

export class VisitStore {
  constructor(private readonly db: Db) {}

  // the first instant of a day stays; a later request that day is a no-op
  record(userId: string, day: string, at: number): void {
    this.db
      .query("insert or ignore into visits (user_id, day, at) values (?, ?, ?)")
      .run(userId, day, at);
  }

  // the days from first to last, both included, as the person's dates
  days(userId: string, first: string, last: string): string[] {
    return this.db
      .query<{ day: string }, [string, string, string]>(
        "select day from visits where user_id = ? and day >= ? and day <= ?",
      )
      .all(userId, first, last)
      .map((row) => row.day);
  }

  // day, not at, is what a page shows: an instant would move the day for
  // a reader in another zone
  latest(): Map<string, { day: string; at: number }> {
    const rows = this.db
      .query<{ user_id: string; day: string; at: number }, []>(
        `select user_id, max(day) as day, max(at) as at
           from visits group by user_id`,
      )
      .all();
    return new Map(
      rows.map((row) => [row.user_id, { day: row.day, at: row.at }]),
    );
  }

  latestFor(userId: string): string | null {
    return (
      this.db
        .query<{ day: string | null }, [string]>(
          "select max(day) as day from visits where user_id = ?",
        )
        .get(userId)?.day ?? null
    );
  }

  onDays(first: string, last: string): { userId: string; day: string }[] {
    return this.db
      .query<{ userId: string; day: string }, [string, string]>(
        "select user_id as userId, day from visits where day >= ? and day <= ?",
      )
      .all(first, last);
  }

  deleteBefore(at: number): number {
    return this.db.query("delete from visits where at < ?").run(at).changes;
  }
}
