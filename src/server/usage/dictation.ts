// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One row per transcribed clip, apart from the model rounds and the
// decisions. The provider's name is kept as text so a row outlives its
// provider and user; no delete removes it. The audio and the text are
// never stored.

import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type DictationUsageFields = {
  userId: string;
  providerId: string;
  providerName: string;
  model: string;
  // the clip's length, from the WAV's data size
  seconds: number;
  // USD, null where the provider did not say
  cost: number | null;
  now: number;
};

// the clips of a slot of slotMs
export type DictationSums = {
  clips: number;
  seconds: number;
  priced: number;
  cost: number | null;
};

export type DictationSlot = DictationSums & { slot: number };

// the sums by slot over [since, until), for the overview's days
export function dictationSlots(
  db: Db,
  since: number,
  until: number,
  slotMs: number,
): DictationSlot[] {
  return db
    .query<DictationSlot, [number, number]>(
      `select created_at / ${slotMs} as slot, count(*) as clips,
              sum(seconds) as seconds, count(cost) as priced,
              sum(cost) as cost
         from dictation_usage where created_at >= ? and created_at < ?
         group by slot order by slot`,
    )
    .all(since, until);
}

export class DictationUsageStore {
  constructor(private readonly db: Db) {}

  record(fields: DictationUsageFields): void {
    this.db
      .query(
        `insert into dictation_usage (id, user_id, provider_id, provider_name,
           model, seconds, cost, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        fields.userId,
        fields.providerId,
        fields.providerName,
        fields.model,
        fields.seconds,
        fields.cost,
        fields.now,
      );
  }

  // a user's clips since a time
  clipsSince(userId: string, since: number): number {
    return this.db
      .query<{ clips: number }, [string, number]>(
        `select count(*) as clips
           from dictation_usage where user_id = ? and created_at >= ?`,
      )
      .get(userId, since)!.clips;
  }

  // the time of a user's clip since a time, skipping the oldest skip,
  // or null when there are not that many
  clipAt(userId: string, since: number, skip: number): number | null {
    return (
      this.db
        .query<{ at: number }, [string, number, number]>(
          `select created_at as at from dictation_usage
            where user_id = ? and created_at >= ?
            order by created_at limit 1 offset ?`,
        )
        .get(userId, since, skip)?.at ?? null
    );
  }
}
