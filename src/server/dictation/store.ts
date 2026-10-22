// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { DictationSettings } from "../../shared/contracts/dictation.ts";
import type { Db } from "../db/index.ts";

type Raw = {
  provider_id: string;
  model: string;
  enabled: number;
  updated_at: number;
};

// the one settings row; on when it is there and enabled
export class DictationStore {
  constructor(private readonly db: Db) {}

  private raw(): Raw | null {
    return this.db
      .query<Raw, []>(
        "select provider_id, model, enabled, updated_at from dictation_settings where id = 1",
      )
      .get();
  }

  settings(): DictationSettings | null {
    const raw = this.raw();
    return raw === null
      ? null
      : {
          providerId: raw.provider_id,
          model: raw.model,
          updatedAt: raw.updated_at,
        };
  }

  on(): boolean {
    return this.raw()?.enabled === 1;
  }

  // a first save starts off; a later one keeps the switch
  save(providerId: string, model: string, now: number): void {
    this.db
      .query(
        `insert into dictation_settings
           (id, provider_id, model, enabled, updated_at)
         values (1, ?, ?, 0, ?)
         on conflict (id) do update set
           provider_id = excluded.provider_id,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(providerId, model, now);
  }

  // false when there is no row to flip
  setOn(on: boolean, now: number): boolean {
    return (
      this.db
        .query(
          "update dictation_settings set enabled = ?, updated_at = ? where id = 1",
        )
        .run(on ? 1 : 0, now).changes > 0
    );
  }
}
