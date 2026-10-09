// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  acquireSession,
  heldSessions,
} from "../../../src/server/bash/queue.ts";
import { PROCESS_SLOTS } from "../../../src/server/knowledge/limits.ts";
import { acquireProcess } from "../../../src/server/knowledge/queue.ts";
import { callCaps, freshSignal, run, scratchState, setup } from "./helpers.ts";

describe("command admission", () => {
  test.serial(
    "one session runs in call order against the prior command's scratch",
    async () => {
      const s = setup();
      try {
        const first = run(s, "printf first > /tmp/file; sleep 0.05; cd /tmp");
        const second = run(s, "cat file; printf second > file");
        const third = run(s, "cat file");
        expect(heldSessions().has(s.session.id)).toBe(true);
        expect((await first).error).toBe(false);
        expect(await second).toEqual({
          error: false,
          content: "first\nexit 0",
          opened: [],
          tail: 6,
        });
        expect(await third).toEqual({
          error: false,
          content: "second\nexit 0",
          opened: [],
          tail: 6,
        });
        expect(scratchState(s)).toMatchObject({ cwd: "/tmp", revision: 3 });
        expect(heldSessions().has(s.session.id)).toBe(false);
      } finally {
        s.db.close();
      }
    },
  );

  test.serial(
    "an abort leaves the session queue without disturbing the next waiter",
    async () => {
      const s = setup();
      const release = await acquireSession(s.session.id, freshSignal());
      const controller = new AbortController();
      const canceled = run(
        s,
        "echo no > /tmp/canceled",
        callCaps,
        controller.signal,
      );
      const next = run(s, "echo next > /tmp/next");
      try {
        controller.abort(new Error("session wait stopped"));
        expect(await canceled).toEqual({
          error: true,
          content: "nothing saved: session wait stopped",
          ended: { phase: "queue", cause: "abort" },
          interrupted: true,
          discarded: true,
        });
        expect(scratchState(s).revision).toBe(0);
        expect(heldSessions().has(s.session.id)).toBe(true);
        release();
        expect((await next).error).toBe(false);
        expect(scratchState(s).entries.map((file) => file.path)).toEqual([
          "next",
        ]);
        expect(heldSessions().has(s.session.id)).toBe(false);
      } finally {
        release();
        await next;
        s.db.close();
      }
    },
  );

  test.serial(
    "session waiters do not consume process slots or block another session",
    async () => {
      const s = setup();
      const release = await acquireSession(s.session.id, freshSignal());
      let finished = 0;
      const waiting = Array.from({ length: 5 }, (_, i) =>
        run(s, `echo ${i} >> /tmp/order`).then((result) => {
          finished++;
          return result;
        }),
      );
      try {
        expect(
          (
            await run(
              s,
              "echo independent > /tmp/file",
              callCaps,
              freshSignal(),
              s.makeSession().id,
            )
          ).error,
        ).toBe(false);
        expect(finished).toBe(0);
        release();
        for (const result of await Promise.all(waiting))
          expect(result.error).toBe(false);
        expect((await run(s, "cat /tmp/order")).content).toStartWith(
          "0\n1\n2\n3\n4\n",
        );
      } finally {
        release();
        await Promise.all(waiting);
        s.db.close();
      }
    },
  );

  test.serial(
    "session holders include process waiters and protect their scratch from sweep",
    async () => {
      const s = setup();
      expect((await run(s, "echo kept > /tmp/file")).error).toBe(false);
      const before = scratchState(s);
      const slots = await Promise.all(
        Array.from({ length: PROCESS_SLOTS }, () =>
          acquireProcess(freshSignal()),
        ),
      );
      const controller = new AbortController();
      const pending = run(s, "true", callCaps, controller.signal);
      try {
        await Promise.resolve();
        expect(s.bash.sweep(101 + 7 * 86_400_000)).toBe(0);
        expect(scratchState(s)).toEqual(before);
        controller.abort("done");
        await pending;
        expect(s.bash.sweep(101 + 7 * 86_400_000)).toBe(1);
      } finally {
        controller.abort();
        for (const release of slots) release();
        await pending;
        s.db.close();
      }
    },
  );

  test.serial(
    "already-aborted calls neither hold nor write a session",
    async () => {
      const s = setup();
      try {
        expect(
          (
            await run(
              s,
              "echo no > /tmp/file",
              callCaps,
              AbortSignal.abort("stopped"),
            )
          ).error,
        ).toBe(true);
        expect(heldSessions().has(s.session.id)).toBe(false);
        expect(scratchState(s).revision).toBe(0);
      } finally {
        s.db.close();
      }
    },
  );
  test.serial(
    "a call that times out waiting for its chat's turn is busy and says to combine steps",
    async () => {
      const s = setup();
      const release = await acquireSession(s.session.id, freshSignal());
      try {
        // the registry's own timer, as it ends a call
        expect(
          await run(s, "echo no > /tmp/no", callCaps, AbortSignal.timeout(50)),
        ).toEqual({
          error: true,
          content:
            "command not run: this chat's earlier commands used the 4 s call timeout, combine steps into fewer commands",
          ended: { phase: "queue", cause: "busy" },
        });
        expect(scratchState(s).revision).toBe(0);
      } finally {
        release();
        s.db.close();
      }
    },
  );

  test.serial(
    "a command that waited and then hit the deadline says how long it had",
    async () => {
      const s = setup();
      const release = await acquireSession(s.session.id, freshSignal());
      const pending = run(s, "while :; do sleep 0.05; done", {
        ...callCaps,
        callTimeoutMs: 2000,
      });
      try {
        await Bun.sleep(1200);
        release();
        const result = await pending;
        expect(result.ended).toEqual({ phase: "run", cause: "deadline" });
        expect(result.content).toMatch(
          /^waited \d+ s behind this chat's earlier commands, so the command had \d+ s to run\n/,
        );
        expect(result.content).toEndWith("exit 124");
      } finally {
        release();
        await pending;
        s.db.close();
      }
    },
  );
  test.serial(
    "a parallel call whose chat's turn comes at its deadline ends busy unmounted",
    async () => {
      const s = setup();
      const caps = { ...callCaps, callTimeoutMs: 1500 };
      const first = run(s, "while :; do sleep 0.05; done", caps);
      const second = run(s, "echo b > /tmp/b", caps);
      try {
        expect((await first).ended).toEqual({
          phase: "run",
          cause: "deadline",
        });
        expect(await second).toEqual({
          error: true,
          content:
            "command not run: this chat's earlier commands used the 2 s call timeout, combine steps into fewer commands",
          ended: { phase: "queue", cause: "busy" },
        });
        expect(s.phases.filter((seen) => seen.phase === "run")).toHaveLength(1);
        expect(scratchState(s).revision).toBe(0);
      } finally {
        await Promise.all([first, second]);
        s.db.close();
      }
    },
  );
});
