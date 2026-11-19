// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell port as the mount drives it: the trusted context a backend
// gets, settle given exactly once with what the commit wrote, landed,
// thrown or skipped, and acquire taken before the process slot, its
// hold given back when the command never ran.

import { describe, expect, spyOn, test } from "bun:test";
import type {
  SettleOutcome,
  ShellBackend,
  ShellCall,
  ShellContext,
  ShellHold,
} from "../../../src/server/bash/index.ts";
import { PROCESS_SLOTS } from "../../../src/server/knowledge/limits.ts";
import { acquireProcess } from "../../../src/server/knowledge/queue.ts";
import {
  afterMountRead,
  callCaps,
  freshSignal,
  run,
  SEND_ID,
  type Setup,
  scratchState,
  setup,
} from "./helpers.ts";

type Acquire = NonNullable<ShellBackend["acquire"]>;

// the builtin shell, watched: every context it ran with and every
// settle it was given
function watched(acquire?: Acquire) {
  const seen = {
    contexts: [] as ShellContext[],
    settles: [] as SettleOutcome[],
    calls: [] as ShellCall[],
  };
  const shell = (builtin: ShellBackend): ShellBackend => ({
    ...(acquire
      ? {
          acquire: (call, deadline, signal) => {
            seen.calls.push(call);
            return acquire(call, deadline, signal);
          },
        }
      : {}),
    async run(job, context, hooks, stops) {
      seen.contexts.push(context);
      const ran = await builtin.run(job, context, hooks, stops);
      return {
        settled: ran.settled,
        settle: (outcome) => {
          seen.settles.push(outcome);
          ran.settle(outcome);
        },
      };
    },
  });
  return { seen, shell };
}

const create = (s: Setup, name: string, text: string) =>
  s.knowledge.create(s.projectId, s.author, name, text);

describe("the shell port", () => {
  test("a backend gets the send and what was mounted, apart from the job", async () => {
    const { seen, shell } = watched();
    const s = setup({}, undefined, undefined, shell);
    try {
      const doc = create(s, "a.md", "old\n");
      await run(s, "true");
      expect(seen.contexts).toHaveLength(1);
      const { stored, ...context } = seen.contexts[0]!;
      // the totals a shell sizes its trees by, before the mount
      expect(stored?.()).toEqual({ docs: 4, scratch: 0, uploads: 0, kept: 0 });
      expect(context).toEqual({
        projectId: s.projectId,
        workspace: { id: s.session.id, sessionId: s.session.id },
        sendId: SEND_ID,
        subagent: false,
        repos: [],
        repoFileBytes: 0,
        network: false,
        credentials: [],
        hold: null,
        mounted: {
          docs: [
            {
              id: doc.id,
              name: "a.md",
              revision: 1,
              updatedAt: doc.updatedAt,
            },
          ],
          scratch: { revision: 0, usedAt: null },
          uploads: { sessionId: s.session.id, revision: 0 },
          kept: [],
        },
      });
      const after = scratchState(s);
      await run(s, "true");
      expect(seen.contexts[1]!.mounted.scratch).toEqual({
        revision: after.revision,
        usedAt: after.usedAt!,
      });
    } finally {
      s.db.close();
    }
  });

  test("a subagent's uploads go by its parent's session", async () => {
    const { seen, shell } = watched();
    const s = setup({}, undefined, undefined, shell);
    try {
      await run(s, "true", {
        ...callCaps,
        subagent: { uploadsFrom: "parent" },
      });
      expect(seen.contexts[0]!.subagent).toBe(true);
      expect(seen.contexts[0]!.mounted.uploads).toEqual({
        sessionId: "parent",
        revision: 0,
      });
    } finally {
      s.db.close();
    }
  });

  test("a landed commit settles once with the rows it wrote", async () => {
    const { seen, shell } = watched();
    const s = setup({}, undefined, undefined, shell);
    try {
      const edited = create(s, "a.md", "old\n");
      const gone = create(s, "b.md", "bye\n");
      s.now.value = 500;
      const result = await run(
        s,
        "printf '\\357\\273\\277new\\n' > a.md; rm b.md; echo c > c.md; echo s > /tmp/s.txt",
      );
      expect(result.error).toBe(false);
      const made = s.knowledge.store.byName(s.projectId, "c.md")!;
      const scratch = scratchState(s);
      expect(seen.settles).toEqual([
        {
          landed: true,
          docs: [
            {
              name: "a.md",
              id: edited.id,
              revision: 2,
              updatedAt: 500,
              // as stored: the BOM the file had is dropped
              text: "new\n",
            },
            {
              name: "c.md",
              id: made.id,
              revision: 1,
              updatedAt: 500,
              text: "c\n",
            },
            // deletes come last, as the read back lists them
            {
              name: "b.md",
              id: gone.id,
              revision: 2,
              updatedAt: 500,
              text: null,
            },
          ],
          scratch: { revision: scratch.revision, usedAt: 500 },
        },
      ]);
    } finally {
      s.db.close();
    }
  });

  test("a command that saves nothing still lands its scratch revision", async () => {
    const { seen, shell } = watched();
    const s = setup({}, undefined, undefined, shell);
    try {
      await run(s, "true");
      expect(seen.settles).toEqual([
        {
          landed: true,
          docs: [],
          scratch: { revision: 1, usedAt: s.now.value },
        },
      ]);
    } finally {
      s.db.close();
    }
  });

  test.each([
    ["a refused tree", "ln -s /knowledge /tmp/l", "not a regular file"],
    ["an exit at a limit", "echo x > a.md; exit 126", "deadline or limit"],
  ])("%s settles once as skipped", async (_, command, words) => {
    const { seen, shell } = watched();
    const s = setup({}, undefined, undefined, shell);
    try {
      const result = await run(s, command);
      expect(result.content).toContain(words);
      expect(seen.settles).toEqual([{ landed: false, why: "skipped" }]);
      expect(s.knowledge.store.byName(s.projectId, "a.md")).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test("a cancelled command settles once as skipped", async () => {
    const { seen, shell } = watched();
    const s = setup({}, undefined, undefined, shell);
    try {
      const abort = new AbortController();
      abort.abort(new Error("stop"));
      const result = await run(s, "true", callCaps, abort.signal);
      expect(result.interrupted).toBe(true);
      // cancelled in the queue: nothing ran, so nothing is owed
      expect(seen.contexts).toEqual([]);
      expect(seen.settles).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("a commit that throws settles once as thrown", async () => {
    const { seen, shell } = watched();
    const s = setup({}, undefined, undefined, shell);
    try {
      const file = create(s, "a.md", "old\n");
      afterMountRead(s, () =>
        s.knowledge.store.replace(file, s.author, "racing", 101),
      );
      const result = await run(s, "echo edit > a.md");
      expect(result.content).toContain("a.md changed while the command ran");
      expect(seen.settles).toEqual([{ landed: false, why: "thrown" }]);
    } finally {
      s.db.close();
    }
  });

  test("a settle that throws leaves the result as it was", async () => {
    const s = setup({}, undefined, undefined, (builtin) => ({
      async run(job, context, hooks, stops) {
        const ran = await builtin.run(job, context, hooks, stops);
        return {
          settled: ran.settled,
          settle: () => {
            throw new Error("settle failed");
          },
        };
      },
    }));
    try {
      const result = await run(s, "echo kept > a.md");
      expect(result.error).toBe(false);
      expect(s.knowledge.store.byName(s.projectId, "a.md")?.text).toBe(
        "kept\n",
      );
    } finally {
      s.db.close();
    }
  });
});

describe("acquire", () => {
  test("a shell that is not free by the deadline ends the command busy", async () => {
    const { seen, shell } = watched(async () => "busy");
    const s = setup({}, undefined, undefined, shell);
    try {
      const result = await run(s, "echo x > a.md");
      expect(result).toEqual({
        content:
          "command not run: waited 0 s for a free shell, the server is busy",
        error: true,
        ended: { phase: "queue", cause: "busy" },
      });
      expect(seen.calls).toHaveLength(1);
      expect(seen.calls[0]!.sendId).toBe(SEND_ID);
      expect(seen.contexts).toEqual([]);
      expect(seen.settles).toEqual([]);
      expect(s.knowledge.store.byName(s.projectId, "a.md")).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test("the hold goes to the run, and settle gives it back", async () => {
    let released = 0;
    const hold: ShellHold = { release: () => released++ };
    const { seen, shell } = watched(async () => hold);
    const s = setup({}, undefined, undefined, shell);
    try {
      await run(s, "true");
      expect(seen.contexts[0]!.hold).toBe(hold);
      expect(seen.settles).toHaveLength(1);
      expect(released).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test("a hold is released when the command never runs", async () => {
    let released = 0;
    const { seen, shell } = watched(async () => ({
      release: () => released++,
    }));
    const s = setup({}, undefined, undefined, shell);
    try {
      // too little of the call left to start a worker
      const result = await run(s, "true", { ...callCaps, callTimeoutMs: 50 });
      expect(result.ended).toEqual({ phase: "queue", cause: "busy" });
      expect(seen.contexts).toEqual([]);
      expect(released).toBe(1);
    } finally {
      s.db.close();
    }
  });

  test.serial(
    "acquire waits under the workspace's queue, holding no slot",
    async () => {
      const order: string[] = [];
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const s = setup({}, undefined, undefined, (builtin) => ({
        async acquire() {
          order.push("acquire");
          entered.resolve();
          await gate.promise;
          return { release: () => {} };
        },
        async run(job, context, hooks, stops) {
          const ran = await builtin.run(job, context, hooks, stops);
          return {
            settled: ran.settled,
            settle: (outcome) => {
              order.push("settle");
              ran.settle(outcome);
            },
          };
        },
      }));
      try {
        const first = run(s, "true");
        const second = run(s, "true", callCaps, freshSignal());
        await entered.promise;
        // every slot is free while a command waits for its shell
        const slots: (() => void)[] = [];
        for (let n = 0; n < PROCESS_SLOTS; n++)
          slots.push(await acquireProcess(freshSignal()));
        for (const release of slots) release();
        gate.resolve();
        await Promise.all([first, second]);
        // the second command reached acquire only after the first settled
        expect(order).toEqual(["acquire", "settle", "acquire", "settle"]);
      } finally {
        s.db.close();
      }
    },
  );
});

// an acquire that answers only its signal
const untilAborted =
  (entered?: () => void): Acquire =>
  (_call, _deadline, signal) =>
    new Promise((_, reject) => {
      entered?.();
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });

// Date.now as the mount reads it, moved on by the test; the worker's
// own clock is its thread's
function shiftedClock() {
  const real = Date.now.bind(Date);
  const clock = { offset: 0 };
  const spy = spyOn(Date, "now").mockImplementation(
    () => real() + clock.offset,
  );
  return { clock, restore: () => spy.mockRestore() };
}

describe("acquire and its hold, when things go wrong", () => {
  test("a run that releases the hold then rejects releases it once", async () => {
    let released = 0;
    const s = setup({}, undefined, undefined, () => ({
      acquire: async () => ({ release: () => released++ }),
      async run(_job, context) {
        context.hold?.release();
        throw new Error("backend broke");
      },
    }));
    try {
      const result = await run(s, "echo x > a.md");
      expect(result.error).toBe(true);
      expect(result.content).toContain("backend broke");
      expect(released).toBe(1);
      expect(s.knowledge.store.byName(s.projectId, "a.md")).toBeNull();
    } finally {
      s.db.close();
    }
  });

  test("an abort during acquire runs nothing", async () => {
    const entered = Promise.withResolvers<void>();
    const { seen, shell } = watched(untilAborted(entered.resolve));
    const s = setup({}, undefined, undefined, shell);
    try {
      const abort = new AbortController();
      const pending = run(s, "echo x > a.md", callCaps, abort.signal);
      await entered.promise;
      abort.abort(new Error("stop"));
      const result = await pending;
      expect(result.interrupted).toBe(true);
      expect(result.ended).toEqual({ phase: "queue", cause: "abort" });
      expect(seen.contexts).toEqual([]);
      expect(seen.settles).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("the deadline inside acquire is busy for a free shell", async () => {
    const { seen, shell } = watched(untilAborted());
    const s = setup({}, undefined, 1, shell);
    try {
      const result = await run(s, "true", { ...callCaps, callTimeoutMs: 50 });
      expect(result).toEqual({
        content:
          "command not run: waited 0 s for a free shell, the server is busy",
        error: true,
        ended: { phase: "queue", cause: "busy" },
      });
      expect(seen.contexts).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test.serial(
    "an abort waiting for a slot after the hold releases it once",
    async () => {
      const slots: (() => void)[] = [];
      for (let n = 0; n < PROCESS_SLOTS; n++)
        slots.push(await acquireProcess(freshSignal()));
      let released = 0;
      const held = Promise.withResolvers<void>();
      const { seen, shell } = watched(async () => {
        held.resolve();
        return { release: () => released++ };
      });
      const s = setup({}, undefined, undefined, shell);
      try {
        const abort = new AbortController();
        const pending = run(s, "true", callCaps, abort.signal);
        await held.promise;
        abort.abort(new Error("stop"));
        const result = await pending;
        expect(result.interrupted).toBe(true);
        expect(released).toBe(1);
        expect(seen.contexts).toEqual([]);
      } finally {
        for (const release of slots) release();
        s.db.close();
      }
    },
  );

  test.serial(
    "a long wait for the shell names the shell, not the slot",
    async () => {
      const { clock, restore } = shiftedClock();
      let released = 0;
      const s = setup({}, undefined, undefined, () => ({
        acquire: async () => {
          clock.offset += 3960;
          return { release: () => released++ };
        },
        run: async () => {
          throw new Error("never run");
        },
      }));
      try {
        // under MIN_RUN_MS of the call left once the shell is held
        const result = await run(s, "true", {
          ...callCaps,
          callTimeoutMs: 4000,
        });
        expect(result).toEqual({
          content:
            "command not run: waited 4 s for a free shell, the server is busy",
          error: true,
          ended: { phase: "queue", cause: "busy" },
        });
        expect(released).toBe(1);
      } finally {
        restore();
        s.db.close();
      }
    },
  );

  test.serial("a late start after a long shell wait says so", async () => {
    const { clock, restore } = shiftedClock();
    const { shell } = watched(async () => {
      clock.offset += 3000;
      return { release: () => {} };
    });
    const s = setup({}, undefined, undefined, shell);
    try {
      const result = await run(s, "exit 124", {
        ...callCaps,
        callTimeoutMs: 4000,
      });
      expect(result.content).toStartWith(
        "waited 3 s for a free shell, so the command had 1 s to run\n",
      );
    } finally {
      restore();
      s.db.close();
    }
  });
});
