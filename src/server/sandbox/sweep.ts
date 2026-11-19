// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the gateway runs under this instance's label that no lease holds:
// left by an earlier process, or a create a crash cut that finished
// after. Sandboxes go first, providers once those deletes ended, since a
// sandbox may still name its providers.

import type { Clock } from "../lib/clock.ts";
import type { Log } from "../lib/log.ts";
import type { Gateway, SandboxInfo, SandboxPhase } from "./gateway.ts";
import { INSTANCE_LABEL } from "./spec.ts";
import { ask } from "./waits.ts";

// one call of a sweep: a list, a provider's delete
export const STEP_MS = 10_000;

export type SweepDeps = {
  clock: Clock;
  log: Log;
  gateway: Gateway;
  instanceId: string;
  // a lease holds it, so it stays; a stuck one is not held and is asked
  // to delete again
  held(name: string): boolean;
  // a provider deleted unless a lease of any manager uses it now, asked
  // under the attach's lock; true when it went
  dropProvider(name: string): Promise<boolean>;
  // a profile deleted unless a lease of any manager uses it, asked
  // under the import's lock right before its delete
  dropProfile(id: string): Promise<void>;
  // recorded as deleting, so it counts against the cap until its delete
  // is observed; settles when that delete ended
  adopt(name: string, phase: SandboxPhase): Promise<void>;
  // the listed sandboxes are recorded, their deletes begun
  counted?(): void;
};

// globalPolicy null when the gateway could not say; listed false when
// its sandboxes, providers or profiles could not be listed, so what was
// not listed is swept again
export async function sweepLabelled(
  deps: SweepDeps,
  when: "start" | "restart" | "again",
): Promise<{ globalPolicy: boolean | null; listed: boolean }> {
  const { clock, log, gateway } = deps;
  const labels = { [INSTANCE_LABEL]: deps.instanceId };
  const globalPolicy = await ask(clock, log, STEP_MS, (signal) =>
    gateway.globalPolicy(signal),
  );
  const found = await ask(clock, log, STEP_MS, (signal) =>
    gateway.list(labels, signal),
  );
  if (found === null) return { globalPolicy, listed: false };
  const deletes = found
    .filter((info) => !deps.held(info.name))
    .map((info) => deps.adopt(info.name, info.phase));
  deps.counted?.();
  await Promise.all(deletes);
  const providers = await ask(clock, log, STEP_MS, (signal) =>
    gateway.providers.list(labels, signal),
  );
  let removed = 0;
  for (const name of providers ?? []) {
    if (await deps.dropProvider(name)) removed++;
  }
  const profiles = await ask(clock, log, STEP_MS, (signal) =>
    gateway.providers.profiles(labels, signal),
  );
  for (const id of profiles ?? []) await deps.dropProfile(id);
  if (deletes.length > 0 || removed > 0) {
    log.info("sandboxes swept", {
      when,
      sandboxes: deletes.length,
      providers: removed,
    });
  }
  return { globalPolicy, listed: providers !== null && profiles !== null };
}

// probes a cut create is looked for: one lands within seconds
export const CUT_PROBES = 10;

// creates cut by their signal: the gateway may still make the sandbox
// after its delete found nothing, so the probe deletes it when listed.
// A name is random and its lease is gone, so no live lease matches it
export class Cuts {
  private readonly names = new Map<string, number>();

  mark(name: string): void {
    this.names.set(name, CUT_PROBES);
  }

  // the listed ones to delete now; each name is looked for a few probes
  due(found: SandboxInfo[], held: (name: string) => boolean): SandboxInfo[] {
    const listed = new Map(found.map((info) => [info.name, info]));
    const due: SandboxInfo[] = [];
    for (const [name, left] of [...this.names]) {
      const info = listed.get(name);
      if (info !== undefined && !held(name)) {
        this.names.delete(name);
        due.push(info);
      } else if (left <= 1) this.names.delete(name);
      else this.names.set(name, left - 1);
    }
    return due;
  }
}
