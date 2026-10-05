// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Deciders: named decision models that answer typed questions about a
// state with probabilities, and the decisions features ask them. A
// decision asks the decider it names, else the default; with none, or
// turned off, the feature stays off.

import {
  type DecisionId,
  type DecisionSummary,
  isDecisionId,
} from "../../shared/contracts/decision.ts";
import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import type { DecisionQuestion } from "../providers/index.ts";
import {
  ask,
  DECIDE_TIMEOUT_MS,
  type Decided,
  type DecideUse,
  type DecisionState,
  type ProvidersPort,
  type UsagePort,
} from "./decide.ts";
import { DecisionStore } from "./decisions.ts";
import { type DaysPort, directoryRoutes } from "./directory.ts";
import { routes, type TotalsPort } from "./routes.ts";
import { type DeciderRow, DeciderStore } from "./store.ts";

export {
  DecisionError,
  type DecisionQuestion,
} from "../providers/index.ts";
export { MAX_MODEL } from "./parse.ts";

export type DecidersDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  providers: ProvidersPort;
  usage: UsagePort & TotalsPort & DaysPort;
};

export type Deciders = {
  store: DeciderStore;
  // the default decider, or null when there is none
  current(): DeciderRow | null;
  usesProvider(providerId: string): boolean;
  // a decision's settings, read at each ask
  decision(id: DecisionId): DecisionSummary;
  // asks the decider the use's decision names, else the default, within
  // DECIDE_TIMEOUT_MS or the caller's signal; null when the decision is
  // off, there is no decider or the state fits nothing, and the caller
  // skips. Every failure is a DecisionError, and only an answer writes
  // a usage row
  decide(
    use: DecideUse,
    questions: Record<string, DecisionQuestion>,
    state: DecisionState,
    signal: AbortSignal,
  ): Promise<Decided | null>;
  routes: RouteDescriptor[];
};

export function decidersArea(deps: DecidersDeps): Deciders {
  const store = new DeciderStore(deps.db);
  const decisions = new DecisionStore(deps.db);
  const current = () => {
    const id = store.defaultId();
    return id === null ? null : store.byId(id);
  };
  return {
    store,
    current,
    usesProvider: (providerId) => store.usesProvider(providerId),
    decision: (id) => decisions.byId(id),
    async decide(use, questions, state, signal) {
      let decider = current();
      if (isDecisionId(use.purpose)) {
        const decision = decisions.byId(use.purpose);
        if (!decision.enabled) return null;
        if (decision.deciderId !== null) {
          decider = store.byId(decision.deciderId) ?? decider;
        }
      }
      if (decider === null) return null;
      return ask(
        deps,
        decider,
        use,
        questions,
        state,
        DECIDE_TIMEOUT_MS,
        signal,
      );
    },
    routes: [
      ...routes({ ...deps, store, decisions }),
      ...directoryRoutes({
        store,
        decisions,
        providers: deps.providers,
        usage: deps.usage,
      }),
    ],
  };
}
