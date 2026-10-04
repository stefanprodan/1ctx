// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a run's attention step is told and what it does with a reply. The
// step asks the run's own model, after its main rounds, whether a user
// needs to act, over the run's record (run-record.ts) with needs_attention
// alone on offer. Offered in the main rounds the tool was called on 5 of
// 48 runs that needed it; asked alone after the run with thinking off,
// on 32 of 32. The wording was measured again, thinking off, without a
// line on memory notes, which flagged healthy runs: 2 of 12 against 6
// of 12 with it, the broken run 4 of 4 either way. Pure.

import type { Message } from "../../shared/contracts/session.ts";
import type { ChatMessageIn, ToolCall } from "../providers/index.ts";
import {
  fitRecord,
  type RecordContext,
  type RecordParts,
  recordParts,
  recordSections,
} from "./run-record.ts";

// a refused reason is written again once; never more
export const ATTENTION_ROUNDS = 2;

// asked after a text reply that is not "ok": a model may write the call
// out as text, which never marks the run
export const ATTENTION_AGAIN =
  "Reply by calling needs_attention with a one-line reason, or with the word ok.";

export const ATTENTION_ASK =
  "Does this run need a user? Call needs_attention with a one-line reason when the run found a problem a user should act on, or could not do its job.";

export type AttentionPacket = {
  // the automation the run belongs to, named in the system prompt
  automation: string;
  sendId: string;
  // the step's first round: the run's rows are those before it
  before: number;
  rows: readonly Message[];
  // the automation's words on when, empty for none
  guidance: string;
};

export function attentionSystem(automation: string): string {
  return `You review a finished run of the ${automation} automation. Its run is over. You do not do its task or write an answer. You read the record of the run and call needs_attention when a user should look at it, and nothing else.`;
}

export function attentionAsk(guidance: string): string {
  const when = guidance === "" ? "" : ` When it needs attention: ${guidance}`;
  return `${ATTENTION_ASK}${when}\n\nWhen it does not, reply with the word ok.`;
}

// the request's messages: the system prompt, the record and the ask,
// then the step's own rounds so far and, after a text reply that was not
// ok, the ask again as a request-local message; null when nothing fits
export function attentionMessages(
  packet: AttentionPacket,
  context: RecordContext & { step: ChatMessageIn[]; again?: boolean },
  count: (text: string) => number,
): ChatMessageIn[] | null {
  const parts = recordParts({
    sendId: packet.sendId,
    before: packet.before,
    cause: "finish",
    error: null,
    rows: packet.rows,
  });
  const build = (current: RecordParts): ChatMessageIn[] => [
    { role: "system", content: attentionSystem(packet.automation) },
    {
      role: "user",
      content: [...recordSections(current), attentionAsk(packet.guidance)].join(
        "\n\n",
      ),
    },
    ...context.step,
    ...(context.again
      ? [{ role: "user" as const, content: ATTENTION_AGAIN }]
      : []),
  ];
  return fitRecord(parts, build, context, count);
}

// "ok", whatever its case, with trailing punctuation
export function isOk(text: string): boolean {
  return /^ok[.!]*$/i.test(text.trim());
}

// whether the step asks again after a round, while a round is left:
// after calls that marked nothing, or after text that is not "ok". The
// text is never read for a mark: only the tool call marks.
export function asksAgain(
  round: number,
  reply: { calls: readonly ToolCall[]; content: string },
  marked: boolean,
): boolean {
  if (round >= ATTENTION_ROUNDS) return false;
  return reply.calls.length > 0 ? !marked : !isOk(reply.content);
}
