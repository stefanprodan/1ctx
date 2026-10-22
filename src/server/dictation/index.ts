// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Dictation: the model an admin picks to turn a composer's clip into text,
// and the route that does it. The usage rows are the usage area's.

import type { Db } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import type { RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { routes } from "./routes.ts";
import { DictationStore } from "./store.ts";
import {
  type LimitsPort,
  type ProvidersPort,
  transcriber,
  type UsagePort,
} from "./transcribe.ts";

export { type Clip, parseWav } from "./wav.ts";

export type DictationDeps = {
  db: Db;
  clock: Clock;
  log: Log;
  providers: ProvidersPort;
  usage: UsagePort;
  limits: LimitsPort;
};

export type Dictation = {
  store: DictationStore;
  // a model is set and switched on; the composer offers its mic
  enabled(): boolean;
  usesProvider(providerId: string): boolean;
  routes: RouteDescriptor[];
};

export function dictationArea(deps: DictationDeps): Dictation {
  const store = new DictationStore(deps.db);
  const transcribe = transcriber({ ...deps, store });
  return {
    store,
    enabled: () => store.on(),
    usesProvider: (providerId) => store.settings()?.providerId === providerId,
    routes: routes({ ...deps, store, transcribe }),
  };
}
