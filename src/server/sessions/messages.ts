// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import type { MessageKind } from "../../shared/words.ts";
import type { Db } from "../db/index.ts";
import { newId } from "../lib/ids.ts";
import { MESSAGE_COLUMNS, message, type RawMessage } from "./rows.ts";

type AgentMessageFields = {
  id?: string;
  sessionId: string;
  sendId: string;
  round: number;
  agentId: string;
  model: string;
  now: number;
};

export function addAgentMessage(
  db: Db,
  kind: Extract<MessageKind, "reply" | "summary">,
  fields: AgentMessageFields,
): Message {
  const id = fields.id ?? newId();
  const seq = db
    .query<{ n: number }, [string]>(
      "select coalesce(max(seq), 0) + 1 as n from messages where session_id = ?",
    )
    .get(fields.sessionId)!.n;
  db.query(
    `insert into messages (id, session_id, seq, kind, send_id, round,
       agent_id, model, status, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'streaming', ?)`,
  ).run(
    id,
    fields.sessionId,
    seq,
    kind,
    fields.sendId,
    fields.round,
    fields.agentId,
    fields.model,
    fields.now,
  );
  const raw = db
    .query<RawMessage, [string]>(
      `select ${MESSAGE_COLUMNS} from messages where id = ?`,
    )
    .get(id)!;
  return message(raw);
}
