// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The send row's reads and its two writes. Sessions own these rows, but
// keeping them here leaves the main store focused.

import type { SendSummary } from "../../shared/contracts/session.ts";
import type { SendCause, SessionStatus } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import type { ReasoningDetail } from "../providers/index.ts";
import { type RawSend, send, sendTokens } from "./rows.ts";

export type SendEnd = {
  status: Exclude<SessionStatus, "running">;
  cause: SendCause;
  error: string | null;
  rounds: number;
  toolCalls: number;
  memoryError: string | null;
  memorySkipped: number | null;
  finishedAt: number;
};

export type SendCounters = {
  rounds: number;
  toolCalls: number;
  memoryRound?: number;
  attentionRound?: number;
  memoryFrom?: number;
};

export function readSend(db: Db, id: string): SendSummary | null {
  const raw = db
    .query<RawSend, [string]>(
      `select *, ${sendTokens("sends")} from sends where id = ?`,
    )
    .get(id);
  return raw ? send(raw) : null;
}

export function readLastSend(db: Db, sessionId: string): SendSummary | null {
  const raw = db
    .query<RawSend, [string]>(
      `select *, ${sendTokens("sends")} from sends where session_id = ?
       order by started_at desc, rowid desc limit 1`,
    )
    .get(sessionId);
  return raw ? send(raw) : null;
}

export function readReasoningDetails(
  db: Db,
  id: string,
  providerId: string,
  model: string,
): ReasoningDetail[] | null {
  const raw = db
    .query<{ reasoning_details: string | null }, [string, string, string]>(
      `select messages.reasoning_details from messages
       join sends on sends.id = messages.send_id
       where messages.id = ? and sends.provider_id = ? and sends.model = ?`,
    )
    .get(id, providerId, model);
  if (!raw?.reasoning_details) return null;
  try {
    const parsed = JSON.parse(raw.reasoning_details);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// the one end of a send, guarded by its running status
export function endSendRow(
  db: Db,
  id: string,
  fields: SendEnd,
): SendSummary | null {
  db.query(
    `update sends set status = ?, cause = ?, error = ?, rounds = ?,
       tool_calls = ?, memory_error = ?, memory_skipped = ?, finished_at = ?
     where id = ? and status = 'running'`,
  ).run(
    fields.status,
    fields.cause,
    fields.error,
    fields.rounds,
    fields.toolCalls,
    fields.memoryError,
    fields.memorySkipped,
    fields.finishedAt,
    id,
  );
  return readSend(db, id);
}

// the counters as the loop advances; memory_round, the first round after
// the run's answer, attention_round and memory_from are each written
// once and never cleared
export function bumpSendCounters(
  db: Db,
  id: string,
  fields: SendCounters,
): SendSummary | null {
  db.query(
    `update sends set rounds = ?, tool_calls = ?,
       memory_round = coalesce(memory_round, ?),
       attention_round = coalesce(attention_round, ?),
       memory_from = coalesce(memory_from, ?)
     where id = ? and status = 'running'`,
  ).run(
    fields.rounds,
    fields.toolCalls,
    fields.memoryRound ?? null,
    fields.attentionRound ?? null,
    fields.memoryFrom ?? null,
    id,
  );
  return readSend(db, id);
}

// who answered each send of the session, a retired agent by its name
export function sendTurns(
  db: Db,
  sessionId: string,
): Map<
  string,
  { agentId: string; agentName: string; summoned: boolean; providerId: string }
> {
  const rows = db
    .query<
      {
        id: string;
        agent_id: string;
        name: string;
        summoned: number;
        provider_id: string;
      },
      [string]
    >(
      `select sends.id, sends.agent_id, agents.name, sends.summoned,
         sends.provider_id
       from sends join agents on agents.id = sends.agent_id
       where sends.session_id = ?`,
    )
    .all(sessionId);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        agentId: row.agent_id,
        agentName: row.name,
        summoned: row.summoned === 1,
        providerId: row.provider_id,
      },
    ]),
  );
}

// the size of the chat's last round, whichever agent answered it: its
// prompt, or a summary round's answer, since the chat is that summary
// now. A regenerate leaves out the send it replaces, whose rounds the
// rerun starts before. Null before the first counted round
export function lastPrompt(
  db: Db,
  sessionId: string,
  excludeSendId: string | null = null,
): number | null {
  const row = db
    .query<
      { prompt_tokens: number; completion_tokens: number; summary: number },
      [string, string | null]
    >(
      `select usage.prompt_tokens, usage.completion_tokens,
         exists (select 1 from messages
           where messages.send_id = usage.send_id
             and messages.round = usage.round
             and messages.kind = 'summary') as summary
       from usage
       where usage.session_id = ? and usage.send_id is not ?
         and exists (select 1 from sends where sends.id = usage.send_id)
       order by usage.seq desc limit 1`,
    )
    .get(sessionId, excludeSendId);
  if (row === null) return null;
  return row.summary === 1 ? row.completion_tokens : row.prompt_tokens;
}
