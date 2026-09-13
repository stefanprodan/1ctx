// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LimitName } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";

export type LimitOverride = {
  name: LimitName;
  value: number;
  changedAt: number;
};

type Raw = {
  name: LimitName;
  value: number;
  updated_at: number;
};

const row = (raw: Raw): LimitOverride => ({
  name: raw.name,
  value: raw.value,
  changedAt: raw.updated_at,
});

export class LimitStore {
  constructor(private readonly db: Db) {}

  rows(): LimitOverride[] {
    return this.db
      .query<Raw, []>("select name, value, updated_at from limits")
      .all()
      .map(row);
  }

  set(name: LimitName, value: number, now: number): void {
    this.db
      .query(
        `insert into limits (name, value, updated_at) values (?, ?, ?)
         on conflict (name) do update set
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(name, value, now);
  }

  delete(name: LimitName): void {
    this.db.query("delete from limits where name = ?").run(name);
  }

  reset(): void {
    this.db.query("delete from limits").run();
  }
}
