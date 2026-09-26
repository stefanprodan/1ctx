// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  DaysUsageResponse,
  DayUsage,
  WeekUsageResponse,
} from "../../shared/api/usage.ts";
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
  // the window as the policy saw it, not as the agent says it now
  contextLength: number | null;
  // what a router said served the round; null when it did not say, and
  // servedModel null when it is the model asked for
  upstream: string | null;
  servedModel: string | null;
  now: number;
};

export type UsageRow = Omit<UsageFields, "now"> & {
  id: string;
  seq: number;
  createdAt: number;
};

type WeekRaw = {
  sends: number;
  sessions: number;
  prompt_tokens: number;
  completion_tokens: number;
};

type WeekTotals = Omit<WeekUsageResponse, "since" | "until">;
type DaysTotals = Pick<DaysUsageResponse, "total" | "projects">;

type DayRaw = {
  project_id: string;
  day_index: number;
  sends: number;
  tokens: number;
};

type TotalRaw = { sends: number; tokens: number };

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
  upstream: string | null;
  served_model: string | null;
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
  upstream: raw.upstream,
  servedModel: raw.served_model,
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

const LIVE_SEND = "exists (select 1 from sends where sends.id = usage.send_id)";

// a turn is a send still there: a regenerate's replaced send and a
// deleted chat's keep their tokens but are no longer turns
const countLive = (alias: string, column: "send_id" | "session_id") =>
  `count(distinct case when exists (select 1 from sends
     where sends.id = ${alias}.send_id) then ${alias}.${column} end)`;

export class UsageStore {
  constructor(private readonly db: Db) {}

  record(fields: UsageFields): UsageRow {
    const id = newId();
    this.db
      .query(
        `insert into usage (id, send_id, session_id, project_id, user_id, agent_id,
           provider_id, model, round, prompt_tokens, completion_tokens,
           cached_tokens, reasoning_tokens, cost, context_length, upstream,
           served_model, created_at, seq)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
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
        fields.upstream,
        fields.servedModel,
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

  week(projectIds: string[], since: number, until: number): WeekTotals {
    if (projectIds.length === 0) {
      return { sends: 0, sessions: 0, promptTokens: 0, completionTokens: 0 };
    }
    const marks = projectIds.map(() => "?").join(", ");
    const raw = this.db
      .query<WeekRaw, (string | number)[]>(
        `select ${countLive("usage", "send_id")} as sends,
                ${countLive("usage", "session_id")} as sessions,
                coalesce(sum(prompt_tokens), 0) as prompt_tokens,
                coalesce(sum(completion_tokens), 0) as completion_tokens
           from usage
          where project_id in (${marks})
            and created_at >= ? and created_at < ?`,
      )
      .get(...projectIds, since, until)!;
    return {
      sends: raw.sends,
      sessions: raw.sessions,
      promptTokens: raw.prompt_tokens,
      completionTokens: raw.completion_tokens,
    };
  }

  days(projectIds: string[], starts: number[], until: number): DaysTotals {
    const projects = projectIds.map((projectId) => ({
      projectId,
      usage: starts.map(() => ({ sends: 0, tokens: 0 })),
    }));
    if (projectIds.length === 0 || starts.length === 0) {
      return { total: { sends: 0, tokens: 0 }, projects };
    }
    const since = starts[0]!;
    const ids = JSON.stringify(projectIds);
    const rows = this.db
      .query<DayRaw, [number, string, string]>(
        `with day_starts as materialized (
           select cast(key as integer) as day_index,
                  cast(value as integer) as start_at,
                  lead(cast(value as integer), 1, ?) over (
                    order by cast(key as integer)
                  ) as end_at
             from json_each(?)
         ), project_ids as materialized (
           select cast(value as text) as project_id from json_each(?)
         )
         select p.project_id, d.day_index,
                ${countLive("u", "send_id")} as sends,
                sum(u.prompt_tokens + u.completion_tokens) as tokens
           from project_ids p
          cross join day_starts d
          cross join usage u
          where u.project_id = p.project_id
            and u.created_at >= d.start_at and u.created_at < d.end_at
          group by p.project_id, d.day_index`,
      )
      .all(until, JSON.stringify(starts), ids);
    const byProject = new Map(
      projects.map((project) => [project.projectId, project]),
    );
    for (const raw of rows) {
      byProject.get(raw.project_id)!.usage[raw.day_index] = {
        sends: raw.sends,
        tokens: raw.tokens,
      };
    }
    const total = this.db
      .query<TotalRaw, [string, number, number]>(
        `select ${countLive("usage", "send_id")} as sends,
                coalesce(sum(prompt_tokens + completion_tokens), 0) as tokens
           from usage
          where project_id in (select value from json_each(?))
            and created_at >= ? and created_at < ?`,
      )
      .get(ids, since, until)!;
    return { total, projects };
  }

  // one agent's days in every project, one series: the agent page's
  // heatmap, which never splits the turns by project
  agentDays(
    agentId: string,
    starts: number[],
    until: number,
  ): { total: DayUsage; usage: DayUsage[] } {
    const usage = starts.map(() => ({ sends: 0, tokens: 0 }));
    if (starts.length === 0) return { total: { sends: 0, tokens: 0 }, usage };
    const rows = this.db
      .query<Omit<DayRaw, "project_id">, [number, string, string]>(
        `with day_starts as materialized (
           select cast(key as integer) as day_index,
                  cast(value as integer) as start_at,
                  lead(cast(value as integer), 1, ?) over (
                    order by cast(key as integer)
                  ) as end_at
             from json_each(?)
         )
         select d.day_index,
                ${countLive("u", "send_id")} as sends,
                sum(u.prompt_tokens + u.completion_tokens) as tokens
           from day_starts d
          cross join usage u
          where u.agent_id = ?
            and u.created_at >= d.start_at and u.created_at < d.end_at
          group by d.day_index`,
      )
      .all(until, JSON.stringify(starts), agentId);
    for (const raw of rows) {
      usage[raw.day_index] = { sends: raw.sends, tokens: raw.tokens };
    }
    const total = this.db
      .query<TotalRaw, [string, number, number]>(
        `select ${countLive("usage", "send_id")} as sends,
                coalesce(sum(prompt_tokens + completion_tokens), 0) as tokens
           from usage
          where agent_id = ? and created_at >= ? and created_at < ?`,
      )
      .get(agentId, starts[0]!, until)!;
    return { total, usage };
  }

  // a regenerate's replaced turn keeps its usage but is no longer the
  // history's size, so only rows of sends that are still there count
  latest(sessionId: string): RoundUsage | null {
    const raw = this.db
      .query<Raw, [string]>(
        `select * from usage where session_id = ? and ${LIVE_SEND}
         order by seq desc limit 1`,
      )
      .get(sessionId);
    return raw ? usageOf(raw) : null;
  }

  latestFor(sessionIds: string[]): Map<string, RoundUsage> {
    const out = new Map<string, RoundUsage>();
    if (sessionIds.length === 0) return out;
    const marks = sessionIds.map(() => "?").join(", ");
    const rows = this.db
      .query<Raw, string[]>(
        `select u.* from usage u
         join (select session_id, max(seq) as seq from usage
               where session_id in (${marks}) and ${LIVE_SEND}
               group by session_id) last
           on last.session_id = u.session_id and last.seq = u.seq`,
      )
      .all(...sessionIds);
    for (const raw of rows) out.set(raw.session_id, usageOf(raw));
    return out;
  }
}
