// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One row per answered decision, apart from the model rounds, which the
// window figures and the agent breakdowns read. The names are kept as
// text so a row outlives its decider and provider; no delete removes it.

import type { DecisionTotals } from "../../shared/api/deciders.ts";
import type { DeciderDay } from "../../shared/api/directory.ts";
import type { DecisionPurpose } from "../../shared/contracts/decision.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { DAY_STARTS } from "./store.ts";

export type DecisionUsageFields = {
  deciderId: string;
  deciderName: string;
  providerId: string;
  providerName: string;
  // the build that answered
  model: string;
  purpose: DecisionPurpose;
  // null for a check
  sessionId: string | null;
  projectId: string | null;
  // null where the server did not say
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  // the whole call, in ms
  duration: number;
  now: number;
};

export type DecisionUsageRow = Omit<DecisionUsageFields, "now"> & {
  id: string;
  createdAt: number;
};

// the decisions of a slot of slotMs
export type DecisionSums = {
  decisions: number;
  tokens: number;
  priced: number;
  cost: number | null;
};

export type DecisionSlot = DecisionSums & { slot: number };

type Raw = {
  id: string;
  decider_id: string;
  decider_name: string;
  provider_id: string;
  provider_name: string;
  model: string;
  purpose: DecisionPurpose;
  session_id: string | null;
  project_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  duration: number;
  created_at: number;
};

const row = (raw: Raw): DecisionUsageRow => ({
  id: raw.id,
  deciderId: raw.decider_id,
  deciderName: raw.decider_name,
  providerId: raw.provider_id,
  providerName: raw.provider_name,
  model: raw.model,
  purpose: raw.purpose,
  sessionId: raw.session_id,
  projectId: raw.project_id,
  inputTokens: raw.input_tokens,
  outputTokens: raw.output_tokens,
  cost: raw.cost,
  duration: raw.duration,
  createdAt: raw.created_at,
});

const SUMS = `count(*) as decisions,
       coalesce(sum(input_tokens), 0) as tokens,
       count(cost) as priced, sum(cost) as cost`;

// the sums by slot over [since, until), for the overview's days
export function decisionSlots(
  db: Db,
  since: number,
  until: number,
  slotMs: number,
): DecisionSlot[] {
  return db
    .query<DecisionSlot, [number, number]>(
      `select created_at / ${slotMs} as slot, ${SUMS}
         from decision_usage where created_at >= ? and created_at < ?
         group by slot order by slot`,
    )
    .all(since, until);
}

export class DecisionUsageStore {
  constructor(private readonly db: Db) {}

  record(fields: DecisionUsageFields): DecisionUsageRow {
    const id = newId();
    this.db
      .query(
        `insert into decision_usage (id, decider_id, decider_name,
           provider_id, provider_name, model, purpose, session_id,
           project_id, input_tokens, output_tokens, cost, duration,
           created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.deciderId,
        fields.deciderName,
        fields.providerId,
        fields.providerName,
        fields.model,
        fields.purpose,
        fields.sessionId,
        fields.projectId,
        fields.inputTokens,
        fields.outputTokens,
        fields.cost,
        fields.duration,
        fields.now,
      );
    return this.byId(id)!;
  }

  byId(id: string): DecisionUsageRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from decision_usage where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  // cost is 0 with no answers
  total(
    by: { deciderId: string } | { purpose: string },
    since: number,
    until: number,
  ): DecisionTotals {
    const [column, value] =
      "deciderId" in by
        ? ["decider_id", by.deciderId]
        : ["purpose", by.purpose];
    return this.db
      .query<DecisionTotals, [string, number, number]>(
        `select count(*) as answers,
                coalesce(sum(input_tokens), 0) as tokens,
                case when count(*) = 0 then 0 else sum(cost) end as cost
           from decision_usage
          where ${column} = ? and created_at >= ? and created_at < ?`,
      )
      .get(value, since, until)!;
  }

  // one decider's decisions per day in every project, its Checks left
  // out: the decider page's heatmap. An answer is one row, so the days
  // sum to the total
  deciderDays(
    deciderId: string,
    starts: number[],
    until: number,
  ): { total: DeciderDay; usage: DeciderDay[] } {
    const usage = starts.map(() => ({ answers: 0, tokens: 0 }));
    const total = { answers: 0, tokens: 0 };
    if (starts.length === 0) return { total, usage };
    const rows = this.db
      .query<DeciderDay & { day_index: number }, [number, string, string]>(
        `with ${DAY_STARTS}
         select d.day_index, count(*) as answers,
                coalesce(sum(u.input_tokens), 0) as tokens
           from day_starts d
          cross join decision_usage u
          where u.decider_id = ? and u.purpose != 'check'
            and u.created_at >= d.start_at and u.created_at < d.end_at
          group by d.day_index`,
      )
      .all(until, JSON.stringify(starts), deciderId);
    for (const raw of rows) {
      usage[raw.day_index] = { answers: raw.answers, tokens: raw.tokens };
      total.answers += raw.answers;
      total.tokens += raw.tokens;
    }
    return { total, usage };
  }
}
