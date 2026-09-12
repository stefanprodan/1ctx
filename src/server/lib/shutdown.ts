// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export type ShutdownDeps = {
  shutdown(signal: string): Promise<void>;
  log(message: string): void;
  exit(code: number): void;
};

export function shutdownOnSignal(signal: string, deps: ShutdownDeps): void {
  void deps.shutdown(signal).catch((err) => {
    deps.log(`${signal}: shutdown failed: ${String(err)}`);
    deps.exit(1);
  });
}
