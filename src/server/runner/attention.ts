// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The decider backup for a run's mark (docs/automations.md).

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
import { decidesLater } from "./marks.ts";
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

// the instructions are fixed; what each option means is the admin's,
// and the automation's own words on when replace needs-attention's
export function outcomeQuestion(
  decision: Pick<DecisionSummary, "options">,
  guidance = "",
): Record<string, DecisionQuestion> {
  return {
    outcome: {
      type: "choice",
      instructions: "What is the outcome of this task run?",
      criteria: Object.fromEntries(
        decision.options.map((o) => [
          o.key,
          o.key === NEEDS_ATTENTION && guidance !== ""
            ? guidance
            : o.description,
        ]),
      ),
    },
  };
}

// a finished run of an automation that asks the decider, which neither
// its agent nor the runner marked
export function asksDecider(send: ActiveSend): boolean {
  return send.terminal !== null && decidesLater(send, send.terminal);
}

export type AttentionPort = {
  decide: Deciders["decide"];
  // the run-attention decision's settings
  decision(): DecisionSummary;
  runAnswer(sendId: string, memoryRound: number | null): string | null;
  // the decider's chance on the run, and with it the automation's open
  // alert opened or closed, in one transaction
  markAttention(sessionId: string, attention: number, by: string): boolean;
  // the decider was not asked or said nothing: the run's end closes the
  // alert, as a clean run's does in the other modes
  undecided(sessionId: string): void;
};

export type Attention = {
  // a finalized send: asked only when asksDecider() holds
  ask(send: ActiveSend): void;
  // every ask queued or in flight has ended
  settled(): Promise<void>;
  // the asks queued or in flight
  pending(): number;
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
  guidance: string;
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

  const undecided = (job: Job) => {
    try {
      port.undecided(job.sessionId);
    } catch (error) {
      failed(job.sessionId, error);
    }
  };

  const run = async (job: Job) => {
    let marked = false;
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
        outcomeQuestion(decision, job.guidance),
        stateOf(answer),
        closing.signal,
      );
      const outcome = decided?.answers.outcome;
      if (decided === null || outcome === undefined) return;
      marked = true;
      port.markAttention(
        job.sessionId,
        outcome.probabilities[NEEDS_ATTENTION] ?? 0,
        decided.decider.name,
      );
    } catch (error) {
      failed(job.sessionId, error);
    } finally {
      // a shutdown leaves the alert as it is
      if (!marked && !closing.signal.aborted) undecided(job);
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
      undecided(dropped);
    }
    const done = new Promise<void>((resolve) => {
      const job: Job = {
        sendId: send.id,
        sessionId: send.sessionId,
        projectId: send.projectId,
        memoryRound: send.memoryRound,
        guidance: send.policy.automation?.attentionGuidance ?? "",
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
      if (closing.signal.aborted || !asksDecider(send)) return;
      // the run has ended: nothing here may reach it
      try {
        enqueue(send);
      } catch (error) {
        failed(send.sessionId, error);
      }
    },
    settled,
    pending: () => asks.size,
    close() {
      closing.abort();
      for (const job of queue.splice(0)) job.start(true);
      return settled();
    },
  };
}
