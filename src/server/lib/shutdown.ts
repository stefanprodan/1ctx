// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { errorFields, type Log } from "./log.ts";

export type ShutdownDeps = {
  shutdown(signal: string): Promise<void>;
  log: Log;
  exit(code: number): void;
};

export function shutdownOnSignal(signal: string, deps: ShutdownDeps): void {
  void deps.shutdown(signal).catch((err) => {
    deps.log.error("shutdown failed", { signal, ...errorFields(err) });
    deps.exit(1);
  });
}
