// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The session's rows as the wire takes them: the system prompt, then
// every user message with its author's name and every reply that has
// something to say. The reply being written is not history yet; a
// reply that failed with nothing in it never was. Reasoning goes back
// only in its structured form, which is what an upstream verifies.
// Pure over the rows and two lookups, so it is tested on fixtures.

import type { Message } from "../../shared/contracts/session.ts";
import type {
  ChatMessageIn,
  ChatRequest,
  ReasoningDetail,
} from "../providers/index.ts";
import type { SendPolicy } from "./policy.ts";
import { systemPrompt } from "./prompt.ts";

export type ContextLookups = {
  // the author's username, for the name field on the wire
  usernameOf(userId: string): string | null;
  reasoningDetailsOf(messageId: string): ReasoningDetail[] | null;
};

export function history(
  rows: Message[],
  policy: Pick<SendPolicy, "prompt" | "about" | "username" | "userId">,
  lookups: ContextLookups,
  now: number,
): ChatMessageIn[] {
  const out: ChatMessageIn[] = [
    { role: "system", content: systemPrompt(policy, now) },
  ];
  for (const row of rows) {
    if (row.kind === "user") {
      const name =
        row.userId === policy.userId
          ? policy.username
          : row.userId === null
            ? null
            : lookups.usernameOf(row.userId);
      out.push({
        role: "user",
        content: row.content,
        ...(name === null ? {} : { name }),
      });
      continue;
    }
    if (row.status === "streaming") continue;
    if (row.content === "") continue;
    const details = lookups.reasoningDetailsOf(row.id);
    out.push({
      role: "assistant",
      content: row.content,
      ...(details ? { reasoningDetails: details } : {}),
    });
  }
  return out;
}

export function request(
  policy: SendPolicy,
  sessionId: string,
  messages: ChatMessageIn[],
): ChatRequest {
  return {
    model: policy.model,
    messages,
    thinking: policy.thinking,
    cacheKey: sessionId,
    ...(policy.tools.length > 0 ? { tools: policy.tools } : {}),
  };
}
