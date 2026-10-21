// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message } from "../../shared/contracts/session.ts";
import type { Db } from "../db/index.ts";
import type { ReasoningDetail } from "../providers/index.ts";
import { roundComplete, type Turn } from "./render.ts";
import { roundKey, toolRowsByRound } from "./trace.ts";

export type ChannelTurn = Turn & {
  firstMessageId: string;
  firstSeq: number;
  swept: boolean;
  // a run's answer its automation posted: another agent's answer to
  // every reader, its own agent included, traced from its stored calls
  run?: true;
};

export type ChannelRow = Message & {
  username: string | null;
  details: ReasoningDetail[] | null;
};

type RawRow = Omit<
  ChannelRow,
  "toolCalls" | "uploads" | "saved" | "details" | "run"
> & {
  toolCalls: string | null;
  uploads: string | null;
  saved: string | null;
  details: string | null;
  runCalls: string | null;
};

const columns = (whole: boolean) => `
  messages.id, messages.session_id as sessionId, messages.seq, messages.kind,
  messages.send_id as sendId, messages.round, messages.slot,
  messages.user_id as userId, messages.agent_id as agentId,
  ${whole ? "messages.content" : "case when messages.kind != 'tool' then messages.content else '' end"} as content,
  messages.uploads, messages.saved, messages.status, messages.model,
  messages.tool_calls as toolCalls, messages.tool_call_id as toolCallId,
  messages.tool_name as toolName, messages.created_at as createdAt,
  messages.finished_at as finishedAt, users.username,
  messages.run_calls as runCalls,
  ${whole ? "messages.reasoning" : "''"} as reasoning,
  ${whole ? "messages.reasoning_details" : "null"} as details`;

const rowOf = ({ runCalls, ...raw }: RawRow): ChannelRow => ({
  ...raw,
  // only the calls are read here: the run's link and name are the page's
  ...(runCalls === null
    ? {}
    : {
        run: {
          calls: JSON.parse(runCalls),
          sessionId: null,
          automationName: null,
        },
      }),
  toolCalls: raw.toolCalls === null ? null : JSON.parse(raw.toolCalls),
  uploads: raw.uploads === null ? null : JSON.parse(raw.uploads),
  saved: raw.saved === null ? null : JSON.parse(raw.saved),
  details: raw.details === null ? null : JSON.parse(raw.details),
  html: "",
  files: null,
  resultBytes: null,
  promptTokens: null,
  error: null,
  finishReason: null,
  ttftMs: null,
  thinkingMs: null,
  upstream: null,
  servedModel: null,
  nativeFinish: null,
});

export function channelRead(db: Db, sessionId: string, from: number) {
  const raw = db
    .query<
      RawRow & {
        turnAgent: string | null;
        agentName: string | null;
        providerId: string | null;
        firstMessageId: string;
        firstSeq: number;
        swept: number | null;
        sendKind: string;
      },
      [string, number, number]
    >(
      `select ${columns(false)}, sends.agent_id as turnAgent,
         agents.name as agentName, sends.provider_id as providerId,
         sends.first_message_id as firstMessageId, first.seq as firstSeq,
         sends.swept, sends.kind as sendKind
       from messages
       cross join sends on sends.id = messages.send_id
       join messages as first on first.id = sends.first_message_id
       left join agents on agents.id = sends.agent_id
       left join users on users.id = messages.user_id
       where messages.session_id = ? and messages.seq >= ?
         and first.seq >= ?
         and (messages.kind = 'user' or sends.status != 'running')
       order by messages.seq`,
    )
    .all(sessionId, from, from);
  const turns = new Map<string, ChannelTurn>();
  for (const row of raw) {
    if (row.turnAgent === null || row.agentName === null) continue;
    turns.set(row.sendId, {
      agentId: row.turnAgent,
      agentName: row.agentName,
      providerId: row.providerId ?? undefined,
      summoned: true,
      firstMessageId: row.firstMessageId,
      firstSeq: row.firstSeq,
      swept: row.swept === 1,
      ...(row.sendKind === "post" ? { run: true as const } : {}),
    });
  }
  return { rows: raw.map(rowOf), turns };
}

// Only the current send and the one candidate for whole replay read results.
export function channelOwnRows(db: Db, sendId: string): ChannelRow[] {
  return db
    .query<RawRow, [string]>(
      `select ${columns(true)} from messages
       left join users on users.id = messages.user_id
       where messages.send_id = ? order by messages.seq`,
    )
    .all(sendId)
    .map(rowOf);
}

export function channelTurnChars(
  db: Db,
  sendId: string,
  rows: readonly ChannelRow[],
): number {
  const byRound = toolRowsByRound(rows);
  const ids = rows.flatMap((row) => {
    if (
      row.kind !== "reply" ||
      row.slot !== "work" ||
      row.status === "streaming" ||
      !row.toolCalls?.length
    ) {
      return [];
    }
    const results = byRound.get(roundKey(row));
    return roundComplete(row.toolCalls, results)
      ? results.map((result) => result.id)
      : [];
  });
  // Only emitted results are a lower bound on every wire. In particular,
  // large thinking that the wire omits must not disqualify a fitting tail.
  return db
    .query<{ chars: number }, [string, string]>(
      `select coalesce(sum(length(content)), 0) as chars
       from messages where send_id = ?
         and id in (select value from json_each(?))`,
    )
    .get(sendId, JSON.stringify(ids))!.chars;
}
