// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  DECISION_OPTIONS,
  DECISIONS,
  type DecisionId,
  type DecisionSummary,
} from "../../shared/contracts/decision.ts";
import type { Db } from "../db/index.ts";

export type DecisionFields = {
  enabled: boolean;
  deciderId: string | null;
  // every option key of the decision, each description trimmed
  options: Record<string, string>;
};

// the decider a decision asks: the one it names, else the default; none
// when it is off
export function deciderIdFor(
  decision: Pick<DecisionSummary, "enabled" | "deciderId">,
  defaultId: string | null,
): string | null {
  return decision.enabled ? (decision.deciderId ?? defaultId) : null;
}

export class DecisionStore {
  constructor(private readonly db: Db) {}

  list(): DecisionSummary[] {
    return DECISIONS.map((id) => this.byId(id));
  }

  byId(id: DecisionId): DecisionSummary {
    const raw = this.db
      .query<{ enabled: number; decider_id: string | null }, [string]>(
        "select enabled, decider_id from decisions where id = ?",
      )
      .get(id);
    const own = new Map(
      this.db
        .query<{ option: string; description: string }, [string]>(
          "select option, description from decision_options where decision_id = ?",
        )
        .all(id)
        .map((o) => [o.option, o.description]),
    );
    return {
      id,
      enabled: raw ? raw.enabled === 1 : true,
      deciderId: raw?.decider_id ?? null,
      options: DECISION_OPTIONS[id].map((o) => ({
        key: o.key,
        description: own.get(o.key) ?? o.description,
        default: o.description,
      })),
    };
  }

  // the caller's transaction checks the decider; a text equal to the
  // code's drops its row
  save(id: DecisionId, fields: DecisionFields, now: number): void {
    this.db
      .query(
        `insert into decisions (id, enabled, decider_id, updated_at)
         values (?, ?, ?, ?)
         on conflict (id) do update set enabled = excluded.enabled,
           decider_id = excluded.decider_id,
           updated_at = excluded.updated_at`,
      )
      .run(id, fields.enabled ? 1 : 0, fields.deciderId, now);
    for (const option of DECISION_OPTIONS[id]) {
      const text = fields.options[option.key]!;
      if (text === option.description) {
        this.db
          .query(
            "delete from decision_options where decision_id = ? and option = ?",
          )
          .run(id, option.key);
        continue;
      }
      this.db
        .query(
          `insert into decision_options (decision_id, option, description)
           values (?, ?, ?)
           on conflict (decision_id, option)
             do update set description = excluded.description`,
        )
        .run(id, option.key, text);
    }
  }
}
