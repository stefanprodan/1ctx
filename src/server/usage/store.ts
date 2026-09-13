// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { RoundUsage } from "../../shared/contracts/session.ts";
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
  // the model's window as the policy saw it
  contextLength: number | null;
  now: number;
};

export type UsageRow = Omit<UsageFields, "now"> & {
  id: string;
  // the order within the session, from 1
  seq: number;
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
  context_length: number | null;
  seq: number;
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
  contextLength: raw.context_length,
  seq: raw.seq,
  createdAt: raw.created_at,
});

const usageOf = (raw: Raw): RoundUsage => ({
  promptTokens: raw.prompt_tokens,
  completionTokens: raw.completion_tokens,
  cachedTokens: raw.cached_tokens,
  reasoningTokens: raw.reasoning_tokens,
  cost: raw.cost,
  contextLength: raw.context_length,
});

export class UsageStore {
  constructor(private readonly db: Db) {}

  record(fields: UsageFields): UsageRow {
    const id = newId();
    this.db
      .query(
        `insert into usage (id, send_id, session_id, project_id, user_id, agent_id,
           provider_id, model, round, prompt_tokens, completion_tokens,
           cached_tokens, reasoning_tokens, cost, context_length, created_at, seq)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (select coalesce(max(seq), 0) + 1 from usage where session_id = ?))`,
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
        fields.contextLength,
        fields.now,
        fields.sessionId,
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
        "select * from usage where session_id = ? order by seq",
      )
      .all(sessionId)
      .map(row);
  }

  deleteSend(sendId: string): boolean {
    return (
      this.db.query("delete from usage where send_id = ?").run(sendId).changes >
      0
    );
  }

  // the last round the provider counted for a session
  latest(sessionId: string): RoundUsage | null {
    const raw = this.db
      .query<Raw, [string]>(
        "select * from usage where session_id = ? order by seq desc limit 1",
      )
      .get(sessionId);
    return raw ? usageOf(raw) : null;
  }

  // the same for many sessions in one query, for a list
  latestFor(sessionIds: string[]): Map<string, RoundUsage> {
    const out = new Map<string, RoundUsage>();
    if (sessionIds.length === 0) return out;
    const marks = sessionIds.map(() => "?").join(", ");
    const rows = this.db
      .query<Raw, string[]>(
        `select u.* from usage u
         join (select session_id, max(seq) as seq from usage
               where session_id in (${marks}) group by session_id) last
           on last.session_id = u.session_id and last.seq = u.seq`,
      )
      .all(...sessionIds);
    for (const raw of rows) out.set(raw.session_id, usageOf(raw));
    return out;
  }
}
