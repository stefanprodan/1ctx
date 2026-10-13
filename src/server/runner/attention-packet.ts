// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The attention step's prompt. Offered in the main rounds the tool was called
// on 5 of 48 runs that needed it; asked alone after the run, on 32 of 32.

import type { Message } from "../../shared/contracts/session.ts";
import type { ChatMessageIn } from "../providers/index.ts";
import {
  fitRecord,
  type RecordContext,
  type RecordParts,
  recordParts,
  recordSections,
} from "./run-record.ts";

// a round with no valid verdict is asked again once; never more
export const ATTENTION_ROUNDS = 2;

// asked after a text reply: a model may write the call out as text,
// which is never read for a verdict
export const ATTENTION_AGAIN =
  "Reply by calling attention with needed true and a one-line reason, or with needed false.";

export const ATTENTION_ASK =
  "Does this run need a user? Call attention with needed true and a one-line reason when the run found a problem a user should act on, or could not do its job.";

const ATTENTION_NO = "When it does not, call attention with needed false.";

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
  return `You review a finished run of the ${automation} automation. Its run is over. You do not do its task or write an answer. You read the record of the run and call attention with your verdict, and nothing else.`;
}

export function attentionAsk(guidance: string): string {
  const when = guidance === "" ? "" : ` When it needs attention: ${guidance}`;
  return `${ATTENTION_ASK}${when}\n\n${ATTENTION_NO}`;
}

// the request's messages: the system prompt, the record and the ask,
// then the step's own rounds so far and, after a text reply, the ask
// again as a request-local message; null when nothing fits
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

// whether the step asks again after a round, while a round is left:
// after text or calls that all failed. The text is never read: only a
// valid verdict, yes or no, answers the step.
export function asksAgain(round: number, answered: boolean): boolean {
  return round < ATTENTION_ROUNDS && !answered;
}
