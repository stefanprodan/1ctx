// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The command worker over real workers: a command that never yields is
// ended at the deadline or after a cancel's grace while this thread
// keeps serving, a cancel stops an awaiting command, shutdown ends every
// job, a kept file is read only when a command reads it, and the server
// drops what a worker posts outside the protocol.

import { describe, expect, test } from "bun:test";
import type { Job } from "../../../src/server/bash/protocol.ts";
import { heldSessions } from "../../../src/server/bash/queue.ts";
import {
  type CommandHooks,
  commandWorkers,
} from "../../../src/server/bash/worker.ts";
import { acquireProcess } from "../../../src/server/knowledge/queue.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { collectLogs } from "../../helpers/app.ts";
import {
  COMMAND_WORKER,
  callCaps,
  phaseWatch,
  run,
  setup,
  untilPhase,
} from "./helpers.ts";

const MiB = 1024 * 1024;
// limits high enough that a runaway never stops itself
const job = (command: string, fields: Partial<Job> = {}): Job => ({
  command,
  endsAt: Date.now() + 60_000,
  docs: true,
  visuals: true,
  network: false,
  cwd: "/knowledge",
  knowledgeFileBytes: MiB,
  mountBytes: 64 * MiB,
  ioBytes: MiB,
  iterations: 1e12,
  knowledge: [],
  scratch: [],
  uploads: [],
  kept: [],
  ...fields,
});
const hooks: CommandHooks = { kept: () => null, fetch: null };
const stops = (
  deadline = new AbortController().signal,
  signal = new AbortController().signal,
  phase?: (phase: "run" | "diff") => void,
) => ({ signal, deadline, chat: "chat", ...(phase ? { phase } : {}) });
const BUSY = "while :; do :; done";
const FORGED = new URL("../../fixtures/bash/forged.worker.ts", import.meta.url);
const CRASH = new URL("../../fixtures/bash/crash.worker.ts", import.meta.url);

describe("the command worker", () => {
  test.serial(
    "a busy loop ends at the deadline while this thread keeps serving",
    async () => {
      const workers = commandWorkers(COMMAND_WORKER, silent);
      let last = performance.now();
      let worst = 0;
      const tick = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
      }, 5);
      const started = performance.now();
      try {
        const settled = await workers.run(
          job(BUSY),
          hooks,
          stops(AbortSignal.timeout(400)),
        );
        expect(settled).toMatchObject({
          ok: false,
          phase: "run",
          cause: "deadline",
        });
        expect(performance.now() - started).toBeLessThan(3000);
        // not held for seconds, as a busy loop on this thread would
        expect(worst).toBeLessThan(500);
      } finally {
        clearInterval(tick);
      }
    },
  );

  test("a cancel stops an awaiting command within the grace", async () => {
    const logs = collectLogs();
    const workers = commandWorkers(COMMAND_WORKER, logs.logFactory("k"), 5000);
    const abort = new AbortController();
    const watch = phaseWatch();
    const pending = workers.run(
      job("sleep 30"),
      hooks,
      stops(undefined, abort.signal, watch.phase),
    );
    await watch.running;
    const started = performance.now();
    abort.abort(new Error("send stopped"));
    expect(await pending).toMatchObject({ ok: false, cause: "abort" });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(logs.events).toEqual([]);
  });

  test("a busy loop past its grace is ended, logged, and the next command runs", async () => {
    const logs = collectLogs();
    const workers = commandWorkers(COMMAND_WORKER, logs.logFactory("k"), 100);
    const abort = new AbortController();
    const watch = phaseWatch();
    const pending = workers.run(
      job(BUSY),
      hooks,
      stops(undefined, abort.signal, watch.phase),
    );
    await watch.running;
    abort.abort(new Error("send stopped"));
    expect(await pending).toMatchObject({
      ok: false,
      phase: "run",
      cause: "abort",
    });
    expect(logs.events).toEqual([
      {
        level: "warn",
        area: "k",
        msg: "command cancel unanswered",
        fields: { chat: "chat", phase: "run", duration: 100 },
      },
    ]);
    const next = await workers.run(job("echo again"), hooks, stops());
    expect(next).toMatchObject({ ok: true, answer: { stdout: "again\n" } });
  });

  test("shutdown ends every running job and refuses the next", async () => {
    const workers = commandWorkers(COMMAND_WORKER, silent);
    const first = phaseWatch();
    const second = phaseWatch();
    const busy = workers.run(
      job(BUSY),
      hooks,
      stops(undefined, undefined, first.phase),
    );
    const waiting = workers.run(
      job("sleep 30"),
      hooks,
      stops(undefined, undefined, second.phase),
    );
    await Promise.all([first.running, second.running]);
    workers.close();
    for (const settled of await Promise.all([busy, waiting])) {
      expect(settled).toMatchObject({ ok: false, cause: "abort" });
      expect(!settled.ok && settled.error?.message).toBe(
        "the server is shutting down",
      );
    }
    const late = await workers.run(job("true"), hooks, stops());
    expect(!late.ok && late.error?.message).toBe("the server is shutting down");
  });

  test("a kept file is asked for only when a command reads it", async () => {
    const workers = commandWorkers(COMMAND_WORKER, silent);
    const asked: number[] = [];
    const kept: CommandHooks = {
      kept: (index) => {
        asked.push(index);
        return new TextEncoder().encode(index === 0 ? "first\n" : "second\n");
      },
      fetch: null,
    };
    const paths = ["/mcp/0001-a/result.txt", "/mcp/0002-b/result.txt"];
    const listed = await workers.run(
      job("ls -R /mcp", { kept: paths }),
      kept,
      stops(),
    );
    expect(listed).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
    const read = await workers.run(
      job(`cat ${paths[1]} ${paths[1]}`, { kept: paths }),
      kept,
      stops(),
    );
    expect(read).toMatchObject({
      ok: true,
      answer: { stdout: "second\nsecond\n" },
    });
    expect(asked).toEqual([1]);
  });

  test("messages outside the protocol are dropped and a job settles once", async () => {
    const workers = commandWorkers(FORGED, silent);
    let asked = 0;
    const settled = await workers.run(
      job("forge", { kept: ["/mcp/0001-a/result.txt"] }),
      {
        kept: () => {
          asked++;
          return new TextEncoder().encode("kept");
        },
        fetch: null,
      },
      stops(),
    );
    expect(settled).toEqual({
      ok: true,
      answer: {
        stdout: "2",
        stderr: "",
        exitCode: 0,
        notice: "",
        opened: [],
        changes: null,
        refused: null,
      },
    });
    expect(asked).toBe(1);
  });

  test("an answer of the wrong shape fails the job at once", async () => {
    const logs = collectLogs();
    const workers = commandWorkers(FORGED, logs.logFactory("k"));
    const started = performance.now();
    const settled = await workers.run(
      job("malformed"),
      hooks,
      stops(AbortSignal.timeout(30_000)),
    );
    expect(settled).toMatchObject({ ok: false, phase: "run", cause: "error" });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(logs.events).toEqual([
      {
        level: "warn",
        area: "k",
        msg: "command answer malformed",
        fields: { chat: "chat", phase: "run" },
      },
    ]);
  });

  test("a worker that ends itself mid-job fails it once", async () => {
    const workers = commandWorkers(FORGED, silent);
    const settled = await workers.run(
      job("close"),
      hooks,
      stops(AbortSignal.timeout(30_000)),
    );
    expect(settled).toMatchObject({ ok: false, phase: "run", cause: "error" });
    expect(!settled.ok && settled.error?.message).toBe(
      "the command worker stopped",
    );
  });

  test("an answer racing the deadline settles once", async () => {
    const workers = commandWorkers(FORGED, silent);
    const deadline = new AbortController();
    const pending = workers.run(job("prompt"), hooks, stops(deadline.signal));
    deadline.abort();
    expect(await pending).toMatchObject({ ok: false, cause: "deadline" });
    const racing = new AbortController();
    const answered = workers.run(job("prompt"), hooks, stops(racing.signal));
    const settled = await answered;
    racing.abort();
    expect(settled).toMatchObject({ ok: true, answer: { stdout: "prompt" } });
  });

  test.serial(
    "a worker that throws as it loads fails the command and frees its slots",
    async () => {
      const s = setup({}, CRASH);
      try {
        const result = await run(s, "true");
        expect(result).toMatchObject({
          error: true,
          ended: { phase: "mount", cause: "error" },
        });
        expect(result.content).toStartWith("nothing saved: ");
        expect(heldSessions().has(s.session.id)).toBe(false);
        const slots: (() => void)[] = [];
        for (let i = 0; i < 4; i++)
          slots.push(await acquireProcess(AbortSignal.timeout(1000)));
        for (const release of slots) release();
      } finally {
        s.db.close();
      }
    },
  );

  test("a loop that yields stops at the interpreter's deadline with its words", async () => {
    const workers = commandWorkers(COMMAND_WORKER, silent);
    const settled = await workers.run(
      job("echo x > /knowledge/late; while :; do sleep 0.05; done", {
        endsAt: Date.now() + 1500,
      }),
      hooks,
      stops(AbortSignal.timeout(60_000)),
    );
    expect(settled).toMatchObject({
      ok: true,
      answer: { exitCode: 124, changes: null },
    });
    expect(settled.ok && settled.answer.stderr).toContain("exceeded");
  });

  test("the call timeout is the interpreter's deadline, before the backstop", async () => {
    const s = setup();
    try {
      const result = await run(
        s,
        "echo x > /knowledge/late; while :; do sleep 0.05; done",
        { ...callCaps, callTimeoutMs: 1500 },
      );
      expect(result.error).toBe(true);
      expect(result.content).toContain("exceeded");
      expect(result.content).toEndWith(
        "nothing saved: command stopped at a deadline or limit\nexit 124",
      );
      expect(result.ended).toEqual({ phase: "run", cause: "deadline" });
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });

  test("closing the area ends a running command with nothing saved", async () => {
    const s = setup();
    try {
      const pending = run(s, "echo x > /knowledge/late; sleep 30");
      await untilPhase(s);
      s.bash.close();
      const result = await pending;
      expect(result).toEqual({
        error: true,
        content: "nothing saved: the server is shutting down",
        ended: { phase: "run", cause: "abort" },
      });
      expect(s.knowledge.list(s.projectId).files).toEqual([]);
    } finally {
      s.db.close();
    }
  });
});
