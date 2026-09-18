// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Admission for memory-backed commands across all area instances. A
// process-wide bound limits mounted bytes, while cancellation removes a
// waiter before it can build a filesystem its caller no longer needs.

import { KNOWLEDGE_COMMANDS_IN_FLIGHT } from "./limits.ts";

let active = 0;
const waiting = new Set<() => void>();

export function acquire(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      waiting.delete(start);
      reject(signal.reason);
    };
    const start = () => {
      waiting.delete(start);
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      active++;
      resolve(() => {
        active--;
        waiting.values().next().value?.();
      });
    };
    if (signal.aborted) {
      reject(signal.reason);
    } else if (active < KNOWLEDGE_COMMANDS_IN_FLIGHT) {
      start();
    } else {
      signal.addEventListener("abort", cancel, { once: true });
      waiting.add(start);
    }
  });
}
