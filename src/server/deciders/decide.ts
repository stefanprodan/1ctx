// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { DecisionPurpose } from "../../shared/contracts/decision.ts";
import type { Clock } from "../lib/clock.ts";
import { HttpError } from "../lib/errors.ts";
import {
  type Charged,
  type DecisionAnswer,
  DecisionError,
  type DecisionQuestion,
  type DecisionUsage,
  type Providers,
} from "../providers/index.ts";
import type { DecisionUsageFields } from "../usage/index.ts";
import type { DeciderRow } from "./store.ts";

// long enough for a remote model, short enough that a slow server
// never holds what asked
export const DECIDE_TIMEOUT_MS = 10_000;
// a cold local server loads its model on the first question
export const CHECK_TIMEOUT_MS = 60_000;

export type ProvidersPort = Pick<Providers, "byId" | "model" | "decisions">;

export type UsagePort = {
  recordDecision(fields: DecisionUsageFields): unknown;
};

// what a decision is for, and the chat or run it is about
export type DecideUse = {
  purpose: DecisionPurpose;
  sessionId: string | null;
  projectId: string | null;
};

export type Decided = {
  decider: { id: string; name: string; contextLength: number | null };
  // the build that answered
  served: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
  ms: number;
};

// the state as text, or made from the decider's window when the caller
// cuts it to fit: null when nothing fits, and nothing is asked
export type DecisionState = string | ((window: number | null) => string | null);

export type AskDeps = {
  clock: Clock;
  providers: ProvidersPort;
  usage: UsagePort;
};

export function ask(
  deps: AskDeps,
  decider: DeciderRow,
  use: DecideUse,
  questions: Record<string, DecisionQuestion>,
  state: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Decided>;
export function ask(
  deps: AskDeps,
  decider: DeciderRow,
  use: DecideUse,
  questions: Record<string, DecisionQuestion>,
  state: DecisionState,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Decided | null>;
export async function ask(
  deps: AskDeps,
  decider: DeciderRow,
  use: DecideUse,
  questions: Record<string, DecisionQuestion>,
  state: DecisionState,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Decided | null> {
  const provider = deps.providers.byId(decider.providerId);
  if (provider === null) {
    throw new DecisionError(`${decider.name} has no provider`);
  }
  const text =
    typeof state === "function" ? state(decider.contextLength) : state;
  if (text === null) return null;
  const started = deps.clock();
  const record = ({ served, usage }: Charged) => {
    const ms = Math.max(0, Math.round(deps.clock() - started));
    deps.usage.recordDecision({
      deciderId: decider.id,
      deciderName: decider.name,
      providerId: provider.id,
      providerName: provider.name,
      model: served,
      purpose: use.purpose,
      sessionId: use.sessionId,
      projectId: use.projectId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: usage.cost,
      duration: ms,
      now: deps.clock(),
    });
    return ms;
  };
  let answer: Awaited<ReturnType<ProvidersPort["decisions"]>>;
  try {
    answer = await deps.providers.decisions(
      provider.id,
      { model: decider.model, state: text, questions },
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    );
  } catch (err) {
    if (err instanceof DecisionError && err.charged !== null) {
      record(err.charged);
    }
    // a provider deleted while the call started
    if (err instanceof HttpError) throw new DecisionError(err.message);
    throw err;
  }
  const ms = record(answer);
  return {
    decider: {
      id: decider.id,
      name: decider.name,
      contextLength: decider.contextLength,
    },
    served: answer.served,
    answers: answer.answers,
    usage: answer.usage,
    ms,
  };
}

// the fixed yes/no a check asks: every decision model takes the type
export const CHECK_STATE = "This is a connection check from 1ctx.";
export const CHECK_QUESTIONS: Record<string, DecisionQuestion> = {
  check: { type: "noul", instructions: "Is this text a connection check?" },
};
