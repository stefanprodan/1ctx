// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Message, SessionDetail } from "../../shared/contracts/session.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import type { Log } from "../lib/log.ts";
import type { SessionRow, SessionStore } from "../sessions/index.ts";
import type { SendPolicy } from "./policy.ts";
import { logStart, reserve, startedDetail } from "./prepare.ts";
import type { Registry } from "./registry.ts";
import { type ActiveSend, newSend } from "./send.ts";
import type { Writer } from "./writer.ts";

// the chat's last counted round, with the send and round that name its rows
export type CountedPort = {
  latestRound(sessionId: string): {
    sendId: string;
    round: number;
    promptTokens: number;
    completionTokens: number;
  } | null;
};

export function compactSend(
  deps: {
    sessions: SessionStore;
    usage: CountedPort;
    registry: Registry;
    writer: Writer;
    clock: Clock;
    log: Log;
    run(send: ActiveSend): Promise<void>;
    wake(): void;
  },
  session: SessionRow,
  policy: SendPolicy,
): SessionDetail {
  const messages = deps.sessions.messages(session.id);
  let lastSummarySeq = 0;
  let lastUser: Message | null = null;
  let hasAnswer = false;
  // a fork at a later message of a turn keeps the earlier ones in a
  // send with no reply, which is no turn to compact
  let replied = false;
  for (const message of messages) {
    if (message.kind === "user") replied = false;
    else if (message.kind === "reply") replied = true;
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
  if (!hasAnswer || !replied || lastUser === null) {
    throw new BadRequest("nothing to compact");
  }
  // The last counted round read the rows before its reply and wrote
  // the reply; a row after it (a stopped turn's tool results, a later
  // message) is not in its measure. Without its reply row nothing is
  // known to be measured.
  const counted = deps.usage.latestRound(session.id);
  const through =
    counted === null
      ? null
      : (messages.findLast(
          (message) =>
            message.sendId === counted.sendId &&
            message.round === counted.round &&
            (message.kind === "reply" || message.kind === "summary"),
        )?.seq ?? null);
  const sendId = newId();
  const summaryId = newId();
  const send = newSend({
    id: sendId,
    sessionId: session.id,
    projectId: policy.projectId,
    startedBy: policy.userId,
    kind: "compact",
    op: "compact",
    summarizing: true,
    used:
      counted === null || through === null
        ? null
        : counted.promptTokens + counted.completionTokens,
    usedThrough: through,
    usedPrompt: counted === null ? null : counted.promptTokens,
    policy,
    firstMessageId: lastUser.id,
    replyId: summaryId,
    now: deps.clock(),
  });
  const release = reserve(deps.registry, deps.wake, send);
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
    release();
    throw err;
  }
  logStart(deps.log, session.id, policy, "compact");
  void deps.run(send);
  return startedDetail(deps.sessions, started.session, send, policy.userId);
}
