// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { errorFields, type Log } from "./log.ts";

export type ShutdownDeps = {
  // cut resolves on the second signal, which ends the drain's wait
  shutdown(signal: string, cut: Promise<void>): Promise<void>;
  log: Log;
  exit(code: number): void;
};

// The handler for every signal: the first starts the shutdown, which
// drains, the second ends the drain, and any later one is ignored.
export function shutdownOnSignal(deps: ShutdownDeps): (signal: string) => void {
  let signals = 0;
  let end = () => {};
  const cut = new Promise<void>((resolve) => {
    end = resolve;
  });
  return (signal) => {
    signals++;
    if (signals > 1) {
      end();
      return;
    }
    void deps.shutdown(signal, cut).catch((err) => {
      deps.log.error("shutdown failed", { signal, ...errorFields(err) });
      deps.exit(1);
    });
  };
}
