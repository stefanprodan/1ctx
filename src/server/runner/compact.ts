// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message, SessionDetail } from "../../shared/contracts/session.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import {
  type SessionRow,
  type SessionStore,
  sessionDetail,
} from "../sessions/index.ts";
import type { SendPolicy } from "./policy.ts";
import type { Registry } from "./registry.ts";
import { type ActiveSend, live, newSend } from "./send.ts";
import type { Writer } from "./writer.ts";

export function compactSend(
  deps: {
    sessions: SessionStore;
    registry: Registry;
    writer: Writer;
    clock: Clock;
    log: Log;
    run(send: ActiveSend): Promise<void>;
  },
  session: SessionRow,
  policy: SendPolicy,
): SessionDetail {
  const messages = deps.sessions.messages(session.id);
  let lastSummarySeq = 0;
  let lastUser: Message | null = null;
  let hasAnswer = false;
  for (const message of messages) {
    if (message.kind === "summary" && message.status === "done") {
      lastSummarySeq = message.seq;
      hasAnswer = false;
    } else if (
      message.kind === "reply" &&
      message.status === "done" &&
      message.slot === "answer" &&
      message.seq > lastSummarySeq
    ) {
      hasAnswer = true;
    }
    if (message.kind === "user") lastUser = message;
  }
  if (!hasAnswer || lastUser === null) {
    throw new BadRequest("nothing to compact");
  }
  deps.registry.admit(session.id, policy.userId);
  const sendId = newId();
  const summaryId = newId();
  const send = newSend({
    id: sendId,
    sessionId: session.id,
    projectId: policy.projectId,
    kind: "compact",
    op: "compact",
    summarizing: true,
    // The last counted round is the size the history has now.
    used:
      session.usage === null
        ? null
        : session.usage.promptTokens + session.usage.completionTokens,
    policy,
    firstMessageId: lastUser.id,
    replyId: summaryId,
    now: deps.clock(),
  });
  deps.registry.set(send);
  let started: ReturnType<Writer["startCompact"]>;
  try {
    started = deps.writer.startCompact({
      sendId,
      summaryId,
      firstMessageId: lastUser.id,
      session,
      policy,
    });
  } catch (err) {
    deps.registry.free(send);
    throw err;
  }
  deps.log.info("send start", {
    chat: session.id,
    user: policy.username,
    agent: policy.agentName,
    provider: policy.providerName,
    model: policy.model,
    op: "compact",
  });
  void deps.run(send);
  return sessionDetail(deps.sessions, started.session, live(send));
}
