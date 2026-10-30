// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { compactsAt } from "../../shared/compaction.ts";
import type { Message } from "../../shared/contracts/session.ts";
import { type Db, transact } from "../db/index.ts";
import { BadRequest, NotFound } from "../lib/errors.ts";
import { CHARS_PER_TOKEN } from "../lib/tokens.ts";
import type { ChannelCaps } from "../limits/index.ts";
import { type ChatMessageIn, requestTokens } from "../providers/index.ts";
import { REFUSABLE_REASONING } from "../sessions/index.ts";
import { channelLocal, channelSystem } from "./channel-prompt.ts";
import {
  type ChannelRow,
  type ChannelTurn,
  channelOwnRows,
  channelRead,
  channelTurnChars,
} from "./channel-read.ts";
import {
  channelLookups,
  ownsChannelTurn,
  type StreamTurn,
  streamTurns,
  tracedTurn,
  trimStream,
} from "./channel-stream.ts";
import { request } from "./context.ts";
import type { SendPolicy } from "./policy.ts";
import { NO_REPO_LINES, type RepoLines } from "./prompt.ts";
import { renderRows } from "./render.ts";
import { TAIL_MAX_TOKENS, tailOf } from "./tail.ts";
import { yoursOf } from "./trace.ts";

export type ChannelContext = {
  forgetReasoning(): void;
  messages(
    excludeId: string | null,
    mcpNote: string,
    repos: RepoLines,
  ): ChatMessageIn[];
};

export function channelFloor(
  policy: Pick<SendPolicy, "agentName" | "contextLength">,
  caps: ChannelCaps,
): void {
  if (
    policy.contextLength === null ||
    policy.contextLength < caps.channelContextFloor
  ) {
    throw new BadRequest(
      `the channel requires at least ${caps.channelContextFloor} context tokens for ${policy.agentName}`,
    );
  }
}

const markOf = (db: Db, sessionId: string): number =>
  db
    .query<{ dropped_seq: number | null }, [string]>(
      "select dropped_seq from sessions where id = ?",
    )
    .get(sessionId)?.dropped_seq ?? 0;

const METER_CACHE_ENTRIES = 1024;

export function channelMeter(
  db: Db,
  caps: () => Pick<ChannelCaps, "channelStreamTokens">,
) {
  const cache = new Map<
    string,
    { revision: number; dropped_seq: number | null; tokens: number }
  >();
  return (sessionId: string) => {
    const state = db
      .query<{ revision: number; dropped_seq: number | null }, [string]>(
        "select revision, dropped_seq from sessions where id = ?",
      )
      .get(sessionId);
    if (state === null) {
      cache.delete(sessionId);
      throw new NotFound("no such chat");
    }
    // A speculative read must not survive a rollback at the same revision.
    let entry = db.inTransaction ? undefined : cache.get(sessionId);
    if (
      entry === undefined ||
      entry.revision !== state.revision ||
      entry.dropped_seq !== state.dropped_seq
    ) {
      const { rows, turns } = channelRead(
        db,
        sessionId,
        state.dropped_seq ?? 0,
      );
      entry = {
        ...state,
        tokens: streamTurns(rows, turns).reduce(
          (sum, part) => sum + part.tokens,
          0,
        ),
      };
    }
    if (!db.inTransaction) {
      cache.delete(sessionId);
      cache.set(sessionId, entry);
      if (cache.size > METER_CACHE_ENTRIES) {
        cache.delete(cache.keys().next().value!);
      }
    }
    return { tokens: entry.tokens, budget: caps().channelStreamTokens };
  };
}

// Called inside the start transaction, before the new send is written.
// Everything before its local line is rendered now, never looked up again.
export function channelContext(fields: {
  db: Db;
  sessionId: string;
  sendId: string;
  posted: Message;
  policy: SendPolicy;
  caps: ChannelCaps;
  now: number;
  mcpNote: string;
}): ChannelContext {
  const { db, sessionId, sendId, posted, policy, caps, now } = fields;
  channelFloor(policy, caps);
  return transact(db, () => {
    const from = markOf(db, sessionId);
    const snapshot = channelRead(db, sessionId, from);
    const trimmed = trimStream(
      streamTurns(snapshot.rows, snapshot.turns),
      caps.channelStreamTokens,
      caps.channelDropTokens,
    );
    if (trimmed.from !== null) {
      db.query("update sessions set dropped_seq = ? where id = ?").run(
        trimmed.from,
        sessionId,
      );
    }
    const lookups = channelLookups(snapshot.rows, snapshot.turns);
    const yours = yoursOf(policy.offered);
    const parts = trimmed.kept.filter(
      (part) => !part.rows.some((row) => row.id === posted.id),
    );
    const owns = (part: StreamTurn) => ownsChannelTurn(part, policy);
    const last = parts.findLast(owns);
    // a whole replay of an own turn, as the latest retained own turn
    const replay = (part: StreamTurn | undefined) => {
      if (
        part === undefined ||
        part.turn!.swept ||
        channelTurnChars(db, part.id, part.rows) >
          TAIL_MAX_TOKENS * CHARS_PER_TOKEN
      ) {
        return null;
      }
      const rows = [
        ...part.rows.filter((row) => row.kind === "user"),
        ...channelOwnRows(db, part.id),
      ];
      // The post's stored send id differs: put it in the same tail unit.
      const unit = rows.map((row) => ({ ...row, sendId: part.id }));
      const tail = tailOf(
        unit,
        unit.length,
        TAIL_MAX_TOKENS,
        policy,
        channelLookups(unit, snapshot.turns),
        snapshot.turns,
        policy.wire,
      );
      return tail.start === 0 ? tail : null;
    };
    const lastWhole = replay(last);
    const whole = lastWhole?.messages ?? null;
    const surplus =
      lastWhole === null ? 0 : Math.max(0, lastWhole.tokens - last!.tokens);
    const stream: ChatMessageIn[] = [];
    const starts = new Map<StreamTurn, number>();
    for (const part of parts) {
      starts.set(part, stream.length);
      stream.push(
        ...(part === last && whole !== null
          ? whole
          : tracedTurn(part, lookups, yours, owns(part))),
      );
    }
    // The agent's next turn traces its whole last turn, so it repeats
    // the stream only up to there. The agent's last turn cached up to
    // the start of the own turn it replayed whole, else its stream's
    // end: marked again, it stays within the lookback of a long stream.
    const end = (whole !== null ? starts.get(last!)! : stream.length) - 1;
    const previous = parts.slice(0, parts.indexOf(last!)).findLast(owns);
    const cached =
      last === undefined
        ? -1
        : starts.get(replay(previous) === null ? last : previous!)! - 1;
    for (const at of [cached, end]) {
      if (at >= 0) stream[at] = { ...stream[at]!, streamMark: true };
    }
    const prefix: ChatMessageIn[] = [
      { role: "system", content: channelSystem(policy) },
      ...stream,
    ];
    const question: ChannelRow = {
      ...posted,
      username: policy.username,
      details: null,
    };
    const own = new Map<string, ChannelTurn>([
      [
        sendId,
        {
          agentId: policy.agentId,
          agentName: policy.agentName,
          providerId: policy.providerId,
          summoned: true,
          firstMessageId: posted.id,
          firstSeq: posted.seq,
          swept: false,
        },
      ],
    ]);
    const renderOwn = (rows: ChannelRow[]) => {
      const all = [question, ...rows];
      return renderRows(all, policy, channelLookups(all, own), own);
    };
    const fit = (local: ChatMessageIn) => {
      const head = requestTokens(
        policy.wire,
        request(policy, sessionId, [prefix[0]!, local, ...renderOwn([])]),
      );
      const actual = requestTokens(
        policy.wire,
        request(policy, sessionId, [...prefix, local, ...renderOwn([])]),
      );
      const threshold = compactsAt(
        policy.contextLength,
        policy.limits.contextReserve,
      )!;
      if (
        Math.max(head + caps.channelStreamTokens + surplus, actual) +
          caps.channelWorkTokens >
        threshold
      ) {
        throw new BadRequest(`the channel is too long for ${policy.agentName}`);
      }
    };
    const localMessage = (
      mcpNote: string,
      repos: RepoLines,
    ): ChatMessageIn => ({
      role: "user",
      content: channelLocal(policy, now, mcpNote, repos),
    });
    fit(localMessage(fields.mcpNote, NO_REPO_LINES));
    let local: ChatMessageIn | null = null;
    return {
      result: {
        forgetReasoning() {
          for (const message of prefix) {
            if (message.role !== "assistant" || !message.reasoningDetails) {
              continue;
            }
            const kept = message.reasoningDetails.filter(
              (item) => !REFUSABLE_REASONING.has(item.type),
            );
            // Retries of this round share these captured message objects.
            if (kept.length > 0) message.reasoningDetails = kept;
            else delete message.reasoningDetails;
          }
        },
        messages(excludeId, mcpNote, repos) {
          if (local === null) {
            local = localMessage(mcpNote, repos);
            // Mounting can add repository descriptions to the tool schemas.
            fit(local);
          }
          const rows = channelOwnRows(db, sendId).filter(
            (row) => row.id !== excludeId,
          );
          return [...prefix, local, ...renderOwn(rows)];
        },
      },
    };
  });
}
