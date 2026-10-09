// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Rows to wire messages; an incomplete work round goes as plain text.

import type { Message } from "../../shared/contracts/session.ts";
import { uploadsBlock } from "../../shared/uploads.ts";
import {
  type ChatMessageIn,
  markOf,
  type ReasoningDetail,
  type ToolCall,
} from "../providers/index.ts";
import type { Offered, SendPolicy } from "./policy.ts";
import {
  roundKey,
  toolRowsByRound,
  trace,
  traceCalls,
  type Yours,
  yoursOf,
} from "./trace.ts";

// who answered a send of the session: its agent and whether it was
// summoned for the turn
export type Turn = {
  agentId: string;
  agentName: string;
  summoned: boolean;
  providerId?: string;
};

export type ContextLookups = {
  // the author's username, for the name field on the wire
  usernameOf(userId: string): string | null;
  reasoningDetailsOf(
    messageId: string,
    providerId: string,
    model: string,
  ): ReasoningDetail[] | null;
  // the session's sends by id
  turnsOf(sessionId: string): ReadonlyMap<string, Turn>;
};

export type RenderPolicy = Pick<
  SendPolicy,
  "username" | "userId" | "providerId" | "model" | "agentId" | "summoned"
> & { offered: Pick<Offered, "mcp" | "skills"> };

type Builder = Pick<SendPolicy, "agentId" | "summoned">;

// a turn is the building agent's own when neither is summoned (a fork's
// copied turns included) or both are summoned sends of the same agent;
// a send the lookup does not know is its own
export function ownTurn(turn: Turn | undefined, policy: Builder): boolean {
  if (turn === undefined) return true;
  return policy.summoned === null
    ? !turn.summoned
    : turn.summoned && turn.agentId === policy.agentId;
}

// an answer without the agent's own mark: a model that read other
// agents' marked answers may open its own the same way. Only a mark
// followed by a space or the end, so a link or reference that opens
// with the name stays; names are lowercase but a model's case is not
export function unmarked(text: string, name: string): string {
  const mark = markOf(name).trimEnd().toLowerCase();
  const start = text.trimStart();
  if (start.slice(0, mark.length).toLowerCase() !== mark) return text;
  const rest = start.slice(mark.length);
  return rest === "" || /^\s/.test(rest) ? rest.trimStart() : text;
}

// another agent's turn: its answer as a user message opened by its
// name, with no author field, then its trace as its own message, the
// calls to tools the building agent lacks marked
function foreignTurn(
  turn: Turn,
  rows: readonly Message[],
  yours: Yours,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [];
  const answer = rows
    .filter(
      (row) =>
        row.kind === "reply" &&
        row.slot !== "work" &&
        row.status !== "streaming" &&
        row.content !== "",
    )
    .map((row) => row.content)
    .join("\n\n");
  if (answer !== "") {
    out.push({ role: "user", content: `${markOf(turn.agentName)}${answer}` });
  }
  const calls = trace(traceCalls(rows), yours);
  if (calls !== "") out.push({ role: "user", content: calls });
  return out;
}

// a round goes back with its calls only when every call has its
// result row, in order
export function roundComplete(
  calls: readonly ToolCall[],
  resultRows: readonly Message[] | undefined,
): resultRows is readonly Message[] {
  return (
    resultRows !== undefined &&
    resultRows.length === calls.length &&
    calls.every((call, index) => resultRows[index]?.toolCallId === call.id)
  );
}

// a user message on the wire, with the author's name when it is not the
// sender and is known
function userMessage(
  row: Message,
  policy: Pick<SendPolicy, "username" | "userId">,
  lookups: ContextLookups,
): ChatMessageIn {
  const name =
    row.userId === policy.userId
      ? policy.username
      : row.userId === null
        ? null
        : lookups.usernameOf(row.userId);
  return {
    role: "user",
    content: row.uploads?.length
      ? `${row.content}\n\n${uploadsBlock(row.uploads)}`
      : row.content,
    ...(name === null ? {} : { name }),
  };
}

// reasoning stays with its provider; the message's model lets a wire
// that sends it back keep only the requested model's
const plainReasoning = (row: Message, sameProvider: boolean) =>
  sameProvider && row.reasoning !== "" ? { reasoning: row.reasoning } : {};

// an assistant reply that asked for tools, with a complete set of
// result rows: the calls and the reasoning go back
function workMessage(
  row: Message,
  calls: ToolCall[],
  policy: Pick<SendPolicy, "providerId" | "model">,
  lookups: ContextLookups,
  sameProvider: boolean,
): ChatMessageIn {
  const details = lookups.reasoningDetailsOf(
    row.id,
    policy.providerId,
    policy.model,
  );
  return {
    role: "assistant",
    model: row.model ?? undefined,
    content: row.content === "" ? null : row.content,
    toolCalls: calls,
    ...plainReasoning(row, sameProvider),
    ...(details ? { reasoningDetails: details } : {}),
  };
}

// the rows as the wire takes them; turns is the session's sends, read
// once by the caller
export function renderRows(
  rows: readonly Message[],
  policy: RenderPolicy,
  lookups: ContextLookups,
  turns: ReadonlyMap<string, Turn>,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [];
  const own = (sendId: string) => ownTurn(turns.get(sendId), policy);
  const sameProvider = (row: Message) =>
    turns.get(row.sendId)?.providerId === policy.providerId;
  const yours = yoursOf(policy.offered);
  const byRound = toolRowsByRound(rows);
  // another agent's rows of one send, sent as its answer and trace once
  // the send's rows end
  let foreign: Message[] = [];
  const flush = () => {
    const first = foreign[0];
    if (first !== undefined) {
      out.push(...foreignTurn(turns.get(first.sendId)!, foreign, yours));
    }
    foreign = [];
  };
  for (const row of rows) {
    if (foreign.length > 0 && row.sendId !== foreign[0]!.sendId) flush();
    if (row.kind === "summary") continue;
    if (row.kind !== "user" && !own(row.sendId)) {
      foreign.push(row);
      continue;
    }
    if (row.kind === "user") {
      out.push(userMessage(row, policy, lookups));
      continue;
    }
    if (row.kind === "tool") {
      // an orphan tool row (no assistant turn placed it) is skipped by
      // the reply branch below; a paired one is emitted there in order
      continue;
    }
    // a reply row
    if (row.status === "streaming") continue;
    const calls = row.toolCalls ?? [];
    if (row.slot === "work" && calls.length > 0) {
      const resultRows = byRound.get(roundKey(row));
      if (roundComplete(calls, resultRows)) {
        out.push(workMessage(row, calls, policy, lookups, sameProvider(row)));
        calls.forEach((call, index) => {
          const result = resultRows[index]!;
          out.push({
            role: "tool",
            toolCallId: call.id,
            content: result.content,
            ...(result.status === "failed" ? { failed: true } : {}),
          });
        });
        continue;
      }
      // the round is incomplete: send it without its calls and without
      // any of its reasoning, as plain text if it has any, else skip
      if (row.content !== "") {
        out.push({
          role: "assistant",
          model: row.model ?? undefined,
          content: row.content,
        });
      }
      continue;
    }
    if (row.content === "") continue;
    const details = lookups.reasoningDetailsOf(
      row.id,
      policy.providerId,
      policy.model,
    );
    out.push({
      role: "assistant",
      model: row.model ?? undefined,
      content: row.content,
      ...plainReasoning(row, sameProvider(row)),
      ...(details ? { reasoningDetails: details } : {}),
    });
  }
  flush();
  return out;
}
