// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  acquire,
  acquireSession,
  heldSessions,
} from "../../../src/server/knowledge/queue.ts";
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
        });
        expect(await third).toEqual({
          error: false,
          content: "second\nexit 0",
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
    "an abort leaves the process queue and releases the held session",
    async () => {
      const s = setup();
      const slots = await Promise.all(
        Array.from({ length: 4 }, () => acquire(freshSignal())),
      );
      const controller = new AbortController();
      const canceled = run(
        s,
        "echo no > /tmp/canceled",
        callCaps,
        controller.signal,
      );
      try {
        await Promise.resolve();
        expect(heldSessions().has(s.session.id)).toBe(true);
        controller.abort(new Error("process wait stopped"));
        expect(await canceled).toEqual({
          error: true,
          content: "nothing saved: process wait stopped",
        });
        expect(heldSessions().has(s.session.id)).toBe(false);
        expect(scratchState(s).revision).toBe(0);
        slots[0]!();
        expect((await run(s, "echo next > /tmp/next")).error).toBe(false);
        expect(scratchState(s).entries.map((file) => file.path)).toEqual([
          "next",
        ]);
      } finally {
        controller.abort();
        for (const release of slots) release();
        await canceled;
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
    "a thrown mount releases both queues, including all four process slots",
    async () => {
      const s = setup();
      const read = s.area.store.read.bind(s.area.store);
      const slots: (() => void)[] = [];
      s.area.store.read = () => {
        throw new Error("mount failed");
      };
      try {
        expect(await run(s, "true")).toEqual({
          error: true,
          content: "nothing saved: mount failed",
        });
        expect(heldSessions().has(s.session.id)).toBe(false);
        for (let i = 0; i < 4; i++)
          slots.push(await acquire(AbortSignal.timeout(1000)));
        for (const release of slots) release();
        s.area.store.read = read;
        expect((await run(s, "true")).error).toBe(false);
        expect(scratchState(s).revision).toBe(1);
      } finally {
        for (const release of slots) release();
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
        Array.from({ length: 4 }, () => acquire(freshSignal())),
      );
      const controller = new AbortController();
      const pending = run(s, "true", callCaps, controller.signal);
      try {
        await Promise.resolve();
        expect(s.area.sweep(101 + 7 * 86_400_000)).toBe(0);
        expect(scratchState(s)).toEqual(before);
        controller.abort("done");
        await pending;
        expect(s.area.sweep(101 + 7 * 86_400_000)).toBe(1);
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
});
