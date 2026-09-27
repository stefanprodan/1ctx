// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Clock } from "../lib/clock.ts";
import type { Registry } from "./registry.ts";
import type { ActiveSend } from "./send.ts";

export type ShutdownResult = { ended: number; timedOut: boolean };

// the asks a finished run started are aborted and waited for with the
// streams, within the same deadline, so none writes after the database
// closes
export async function shutdownRunner(
  registry: Registry,
  clock: Clock,
  end: (send: ActiveSend) => void,
  timeoutMs: number,
  closeAsks: () => Promise<void> = async () => {},
): Promise<ShutdownResult> {
  registry.close();
  const sends = registry.values();
  for (const send of sends) end(send);
  const waits = [...sends.map((send) => send.drained), closeAsks()];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = clock.sleep
    ? clock.sleep(timeoutMs).then(() => true)
    : new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      });
  const timedOut = await Promise.race([
    Promise.all(waits).then(() => false),
    deadline,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { ended: sends.length, timedOut };
}
