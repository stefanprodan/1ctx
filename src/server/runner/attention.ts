// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Whether a finished run needs a person: the run-attention decision,
// asked of its decider once the run is done and its frames are out, so
// the ask never holds the run. A failure stores nothing and is not asked
// again; the answer and the decision's settings are read when the ask
// starts.

import {
  DECISION_OPTIONS,
  type DecisionId,
  type DecisionSummary,
} from "../../shared/contracts/decision.ts";
import {
  type Deciders,
  DecisionError,
  type DecisionQuestion,
} from "../deciders/index.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { cutToTokens } from "../lib/tokens.ts";
import type { ActiveSend } from "./send.ts";

// a burst of runs ending together never floods one local server
export const ASKS_AT_ONCE = 2;
// past it the oldest waiting ask is dropped, so a stuck decider holds
// no more than this
export const MAX_QUEUED = 64;
// the question's tokens, since o200k is not every decider's tokenizer
export const QUESTION_TOKENS = 256;
export const UNKNOWN_WINDOW_TOKENS = 4000;

const PURPOSE: DecisionId = "run-attention";
const NEEDS_ATTENTION = DECISION_OPTIONS[PURPOSE][1]!.key;

// the instructions are fixed; what each option means is the admin's
export function outcomeQuestion(
  decision: Pick<DecisionSummary, "options">,
): Record<string, DecisionQuestion> {
  return {
    outcome: {
      type: "choice",
      instructions: "What is the outcome of this task run?",
      criteria: Object.fromEntries(
        decision.options.map((o) => [o.key, o.description]),
      ),
    },
  };
}

export type AttentionPort = {
  decide: Deciders["decide"];
  // the run-attention decision's settings
  decision(): DecisionSummary;
  runAnswer(sendId: string, memoryRound: number | null): string | null;
  markAttention(sessionId: string, attention: number, by: string): boolean;
};

export type Attention = {
  // a finalized send: asked only for a run that finished with an answer
  ask(send: ActiveSend): void;
  // every ask queued or in flight has ended
  settled(): Promise<void>;
  // aborts every ask and waits for them; nothing is asked after
  close(): Promise<void>;
};

// null when the window leaves no room for the answer
export function stateOf(answer: string) {
  return (window: number | null) => {
    const budget =
      window === null
        ? UNKNOWN_WINDOW_TOKENS
        : Math.floor(0.8 * window) - QUESTION_TOKENS;
    return budget <= 0 ? null : cutToTokens(answer, budget);
  };
}

// what reading the answer takes, so a queued ask holds no send
type Job = {
  sendId: string;
  sessionId: string;
  projectId: string;
  memoryRound: number | null;
  start(skip: boolean): void;
};

export function attention(port: AttentionPort, log: Log): Attention {
  const closing = new AbortController();
  const asks = new Set<Promise<void>>();
  const queue: Job[] = [];
  let running = 0;

  const next = () => {
    while (running < ASKS_AT_ONCE && queue.length > 0) {
      queue.shift()!.start(closing.signal.aborted);
    }
  };

  const failed = (chat: string, error: unknown) =>
    log.warn("run attention failed", {
      chat,
      // a refusal, a timeout or an abort is expected; a bug keeps its stack
      ...errorFields(error, !(error instanceof DecisionError)),
    });

  const run = async (job: Job) => {
    try {
      const decision = port.decision();
      if (!decision.enabled) return;
      const answer = port.runAnswer(job.sendId, job.memoryRound);
      if (answer === null) return;
      const decided = await port.decide(
        {
          purpose: PURPOSE,
          sessionId: job.sessionId,
          projectId: job.projectId,
        },
        outcomeQuestion(decision),
        stateOf(answer),
        closing.signal,
      );
      const outcome = decided?.answers.outcome;
      if (decided === null || outcome === undefined) return;
      port.markAttention(
        job.sessionId,
        outcome.probabilities[NEEDS_ATTENTION] ?? 0,
        decided.decider.name,
      );
    } catch (error) {
      failed(job.sessionId, error);
    }
  };

  const settled = async () => {
    while (asks.size > 0) await Promise.all(asks);
  };

  const enqueue = (send: ActiveSend) => {
    if (queue.length >= MAX_QUEUED) {
      const dropped = queue.shift()!;
      log.warn("run attention dropped", { chat: dropped.sessionId });
      dropped.start(true);
    }
    const done = new Promise<void>((resolve) => {
      const job: Job = {
        sendId: send.id,
        sessionId: send.sessionId,
        projectId: send.projectId,
        memoryRound: send.memoryRound,
        start(skip) {
          if (skip) return resolve();
          running += 1;
          void run(job).finally(() => {
            running -= 1;
            resolve();
            next();
          });
        },
      };
      queue.push(job);
    }).finally(() => {
      asks.delete(done);
    });
    asks.add(done);
    next();
  };

  return {
    ask(send) {
      if (
        closing.signal.aborted ||
        send.kind !== "run" ||
        send.terminal !== "finish"
      ) {
        return;
      }
      // the run has ended: nothing here may reach it
      try {
        enqueue(send);
      } catch (error) {
        failed(send.sessionId, error);
      }
    },
    settled,
    close() {
      closing.abort();
      for (const job of queue.splice(0)) job.start(true);
      return settled();
    },
  };
}
