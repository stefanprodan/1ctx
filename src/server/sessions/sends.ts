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

// the counters as the loop advances; memory_round is written once and
// never cleared
export function bumpSendCounters(
  db: Db,
  id: string,
  fields: SendCounters,
): SendSummary | null {
  db.query(
    `update sends set rounds = ?, tool_calls = ?,
       memory_round = coalesce(?, memory_round)
     where id = ? and status = 'running'`,
  ).run(fields.rounds, fields.toolCalls, fields.memoryRound ?? null, id);
  return readSend(db, id);
}
