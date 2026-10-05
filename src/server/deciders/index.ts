// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
import { DecisionStore, deciderIdFor } from "./decisions.ts";
import { type DaysPort, directoryRoutes } from "./directory.ts";
import { routes, type TotalsPort } from "./routes.ts";
import { type DeciderRow, DeciderStore } from "./store.ts";

export {
  DecisionError,
  type DecisionQuestion,
} from "../providers/index.ts";

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
  // null when off, no decider, or no state fits; failures are
  // DecisionErrors
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
      const defaultId = store.defaultId();
      const id = isDecisionId(use.purpose)
        ? deciderIdFor(decisions.byId(use.purpose), defaultId)
        : defaultId;
      if (id === null) return null;
      // a named decider deleted since falls back to the default
      const decider = store.byId(id) ?? current();
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
