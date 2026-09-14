// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import type { Avatar, Effort } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type AgentRow = AgentSummary;

type Raw = {
  id: string;
  name: string;
  avatar: Avatar;
  provider_id: string;
  model: string;
  model_name: string;
  context_length: number | null;
  prompt_price: number | null;
  completion_price: number | null;
  tools: number;
  reasoning: number;
  thinking: "on" | "off" | null;
  effort: Effort | null;
  prompt: string;
  created_at: number;
};

const row = (raw: Raw): AgentRow => ({
  id: raw.id,
  name: raw.name,
  avatar: raw.avatar,
  providerId: raw.provider_id,
  model: {
    id: raw.model,
    name: raw.model_name,
    contextLength: raw.context_length,
    promptPrice: raw.prompt_price,
    completionPrice: raw.completion_price,
    tools: raw.tools === 1,
    reasoning: raw.reasoning === 1,
  },
  thinking: raw.thinking,
  effort: raw.effort,
  prompt: raw.prompt,
  createdAt: raw.created_at,
});

export const summary = (agent: AgentRow): AgentSummary => agent;

export type AgentFields = {
  name: string;
  avatar: Avatar;
  providerId: string;
  // a snapshot: the catalog may change or drop the model later
  model: CatalogMatch;
  thinking: "on" | "off" | null;
  effort: Effort | null;
  prompt: string;
};

export class AgentStore {
  constructor(private readonly db: Db) {}

  list(): AgentRow[] {
    return this.db
      .query<Raw, []>("select * from agents order by created_at, name")
      .all()
      .map(row);
  }

  byId(id: string): AgentRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from agents where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  byName(name: string): AgentRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from agents where name = ?")
      .get(name);
    return raw ? row(raw) : null;
  }

  usesProvider(providerId: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>(
          "select count(*) as n from agents where provider_id = ?",
        )
        .get(providerId)!.n > 0
    );
  }

  create(fields: AgentFields & { now: number }): AgentRow {
    const id = newId();
    const m = fields.model;
    this.db
      .query(
        `insert into agents (id, name, avatar, provider_id, model, model_name,
           context_length, prompt_price, completion_price, tools, reasoning,
           thinking, effort, prompt, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        fields.avatar,
        fields.providerId,
        m.id,
        m.name,
        m.contextLength,
        m.promptPrice,
        m.completionPrice,
        m.tools ? 1 : 0,
        m.reasoning ? 1 : 0,
        fields.thinking,
        fields.effort,
        fields.prompt,
        fields.now,
      );
    return this.byId(id)!;
  }

  update(id: string, fields: AgentFields): AgentRow | null {
    const m = fields.model;
    this.db
      .query(
        `update agents set name = ?, avatar = ?, provider_id = ?, model = ?, model_name = ?,
           context_length = ?, prompt_price = ?, completion_price = ?,
           tools = ?, reasoning = ?, thinking = ?, effort = ?, prompt = ?
         where id = ?`,
      )
      .run(
        fields.name,
        fields.avatar,
        fields.providerId,
        m.id,
        m.name,
        m.contextLength,
        m.promptPrice,
        m.completionPrice,
        m.tools ? 1 : 0,
        m.reasoning ? 1 : 0,
        fields.thinking,
        fields.effort,
        fields.prompt,
        id,
      );
    return this.byId(id);
  }

  delete(id: string): boolean {
    return this.db.query("delete from agents where id = ?").run(id).changes > 0;
  }
}
