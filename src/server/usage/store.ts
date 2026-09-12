// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";

export type UsageFields = {
  sendId: string;
  sessionId: string;
  projectId: string;
  userId: string;
  agentId: string;
  providerId: string;
  model: string;
  round: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  now: number;
};

export type UsageRow = Omit<UsageFields, "now"> & {
  id: string;
  createdAt: number;
};

type Raw = {
  id: string;
  send_id: string;
  session_id: string;
  project_id: string;
  user_id: string;
  agent_id: string;
  provider_id: string;
  model: string;
  round: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  cost: number | null;
  created_at: number;
};

const row = (raw: Raw): UsageRow => ({
  id: raw.id,
  sendId: raw.send_id,
  sessionId: raw.session_id,
  projectId: raw.project_id,
  userId: raw.user_id,
  agentId: raw.agent_id,
  providerId: raw.provider_id,
  model: raw.model,
  round: raw.round,
  promptTokens: raw.prompt_tokens,
  completionTokens: raw.completion_tokens,
  cachedTokens: raw.cached_tokens,
  reasoningTokens: raw.reasoning_tokens,
  cost: raw.cost,
  createdAt: raw.created_at,
});

export class UsageStore {
  constructor(private readonly db: Db) {}

  record(fields: UsageFields): UsageRow {
    const id = newId();
    this.db
      .query(
        `insert into usage (id, send_id, session_id, project_id, user_id, agent_id,
           provider_id, model, round, prompt_tokens, completion_tokens,
           cached_tokens, reasoning_tokens, cost, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.sendId,
        fields.sessionId,
        fields.projectId,
        fields.userId,
        fields.agentId,
        fields.providerId,
        fields.model,
        fields.round,
        fields.promptTokens,
        fields.completionTokens,
        fields.cachedTokens,
        fields.reasoningTokens,
        fields.cost,
        fields.now,
      );
    return this.byId(id)!;
  }

  byId(id: string): UsageRow | null {
    const raw = this.db
      .query<Raw, [string]>("select * from usage where id = ?")
      .get(id);
    return raw ? row(raw) : null;
  }

  forSession(sessionId: string): UsageRow[] {
    return this.db
      .query<Raw, [string]>(
        "select * from usage where session_id = ? order by created_at, round",
      )
      .all(sessionId)
      .map(row);
  }
}
