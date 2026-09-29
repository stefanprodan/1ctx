// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { bashArea } from "../../../src/server/bash/index.ts";
import type { CommandCaps } from "../../../src/server/bash/mount.ts";
import type { ScratchChanges } from "../../../src/server/bash/scratch.ts";
import { transact } from "../../../src/server/db/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import type { KnowledgeCaps } from "../../../src/server/limits/index.ts";
import { setup as knowledgeSetup } from "../knowledge/helpers.ts";

// the real entry, as compose.ts builds it: commands run in a worker here
export const COMMAND_WORKER = new URL(
  "../../../src/server/bash/command.worker.ts",
  import.meta.url,
);

// the knowledge area the commands mount, and the bash area over it
export function setup(
  overrides: Partial<KnowledgeCaps> = {},
  worker = COMMAND_WORKER,
) {
  const { area: knowledge, ...base } = knowledgeSetup(overrides);
  const phases: { sessionId: string; phase: string }[] = [];
  const waking = new Set<() => void>();
  const bash = bashArea({
    db: base.db,
    clock: () => base.now.value,
    limits: { current: () => ({ ...base.caps }) },
    log: silent,
    worker,
    onCommandPhase: (sessionId, phase) => {
      phases.push({ sessionId, phase });
      for (const wake of [...waking]) wake();
    },
    knowledge,
  });
  return { ...base, knowledge, bash, phases, waking };
}

export type Setup = ReturnType<typeof setup>;

export const callCaps = {
  callTimeoutMs: 4000,
  resultCut: 1000,
  visuals: true,
  knowledge: true,
};
export const freshSignal = () => new AbortController().signal;

export const run = (
  s: Setup,
  command: string,
  caps: CommandCaps = callCaps,
  signal = freshSignal(),
  sessionId = s.session.id,
) =>
  s.bash.run(
    s.projectId,
    sessionId,
    { ...s.agent, sessionId },
    command,
    caps,
    signal,
  );

export function seedScratch(s: Setup, changes: Partial<ScratchChanges>) {
  transact(s.db, () => ({
    result: s.bash.scratch.write(
      s.session.id,
      s.bash.scratch.read(s.session.id).revision,
      { written: [], removed: [], cwd: "/knowledge", ...changes },
      s.now.value,
    ),
  }));
}

export function scratchState(s: Setup) {
  return {
    ...s.bash.scratch.read(s.session.id),
    usedAt: s.db
      .query<{ used_at: number }, [string]>(
        "select used_at from session_scratch where session_id = ?",
      )
      .get(s.session.id)?.used_at,
  };
}

// Runs a write right after the next mount reads its rows, the race a
// concurrent writer makes, without waiting on real time.
export function afterMountRead(s: Setup, write: () => void) {
  const store = s.knowledge.store;
  const read = store.mounted;
  store.mounted = (projectId) => {
    store.mounted = read;
    const rows = read.call(store, projectId);
    write();
    return rows;
  };
}

// Resolves once a command of the chat reports the phase, consuming the
// report, so a test cancels a command known to be running rather than
// one it hopes has started; fails past a bounded startup wait.
export function untilPhase(
  s: Setup,
  phase: "run" | "diff" = "run",
  sessionId = s.session.id,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const at = s.phases.findIndex(
        (seen) => seen.sessionId === sessionId && seen.phase === phase,
      );
      if (at < 0) return;
      s.phases.splice(at, 1);
      s.waking.delete(check);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      s.waking.delete(check);
      reject(new Error(`no ${phase} phase within ${timeoutMs} ms`));
    }, timeoutMs);
    s.waking.add(check);
    check();
  });
}

// a phase reported by a command worker, for tests that drive the
// workers directly; a bounded startup wait as above
export function phaseWatch(timeoutMs = 10_000) {
  let reached: () => void = () => {};
  const running = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no run phase within ${timeoutMs} ms`)),
      timeoutMs,
    );
    reached = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return {
    phase: (phase: "run" | "diff") => {
      if (phase === "run") reached();
    },
    running,
  };
}
