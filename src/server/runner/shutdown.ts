// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The runner's end in two steps. drain() closes the registry and waits
// up to its bound for the running sends to end on their own and for the
// attention asks they leave; shutdown() terminates what is left and
// waits, within its own deadline, for the streams, the asks and what
// the caller closes after them.

import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import type { Registry } from "./registry.ts";
import type { ActiveSend } from "./send.ts";

export type ShutdownResult = { ended: number; timedOut: boolean };
export type DrainResult = { drained: number };

// resolves after ms on the clock, and a cancel for a real timer
function deadline(clock: Clock, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = clock.sleep
    ? clock.sleep(ms)
    : new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
  return {
    done,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export async function drainRunner(
  registry: Registry,
  clock: Clock,
  log: Log,
  boundMs: number,
  asks: { pending(): number; settled(): Promise<void> },
  // a second signal: the wait ends at once
  cut: Promise<void>,
): Promise<DrainResult> {
  registry.close();
  const sends = registry.values();
  const pending = asks.pending();
  if (boundMs <= 0 || (sends.length === 0 && pending === 0)) {
    return { drained: 0 };
  }
  log.info("draining", { sends: sends.length, asks: pending, bound: boundMs });
  const started = clock();
  let drained = 0;
  const own = Promise.all(
    sends.map((send) =>
      send.drained.then(() => {
        drained++;
      }),
    ),
  )
    .then(() => asks.settled())
    .then(() => true);
  const bound = deadline(clock, boundMs);
  const finished = await Promise.race([
    own,
    bound.done.then(() => false),
    cut.then(() => false),
  ]);
  bound.cancel();
  const duration = clock() - started;
  if (finished) {
    log.info("drained", { sends: drained, duration });
  } else {
    log.info("drain over", {
      drained,
      terminated: registry.size,
      duration,
    });
  }
  return { drained };
}

// the asks a finished run started are aborted and waited for with the
// streams, and then whatever the caller closes, all within the same
// deadline, so none writes after the database closes; past it the
// close still starts, unwaited
export async function shutdownRunner(
  registry: Registry,
  clock: Clock,
  end: (send: ActiveSend) => void,
  timeoutMs: number,
  closeAsks: () => Promise<void> = async () => {},
  close: () => Promise<void> = async () => {},
): Promise<ShutdownResult> {
  registry.close();
  const sends = registry.values();
  for (const send of sends) end(send);
  let closing: Promise<void> | null = null;
  const closeOnce = () => {
    closing ??= close();
    return closing;
  };
  const waits = Promise.all([
    ...sends.map((send) => send.drained),
    closeAsks(),
  ]).then(closeOnce);
  const bound = deadline(clock, timeoutMs);
  const timedOut = await Promise.race([
    waits.then(() => false),
    bound.done.then(() => true),
  ]);
  bound.cancel();
  if (timedOut) {
    waits.catch(() => {});
    closeOnce().catch(() => {});
  }
  return { ended: sends.length, timedOut };
}
