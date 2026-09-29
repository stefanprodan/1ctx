// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { heldSessions } from "../../../src/server/bash/queue.ts";
import { acquireProcess } from "../../../src/server/knowledge/queue.ts";
import {
  callCaps,
  freshSignal,
  run,
  scratchState,
  setup,
} from "../bash/helpers.ts";

describe("process slots", () => {
  test.serial(
    "an abort leaves the process queue and releases the held session",
    async () => {
      const s = setup();
      const slots = await Promise.all(
        Array.from({ length: 4 }, () => acquireProcess(freshSignal())),
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
          ended: { phase: "queue", cause: "abort" },
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
    "a thrown mount releases both queues, including all four process slots",
    async () => {
      const s = setup();
      const read = s.knowledge.store.mounted.bind(s.knowledge.store);
      const slots: (() => void)[] = [];
      s.knowledge.store.mounted = () => {
        throw new Error("mount failed");
      };
      try {
        expect(await run(s, "true")).toEqual({
          error: true,
          content: "nothing saved: mount failed",
          ended: { phase: "mount", cause: "error" },
        });
        expect(heldSessions().has(s.session.id)).toBe(false);
        for (let i = 0; i < 4; i++)
          slots.push(await acquireProcess(AbortSignal.timeout(1000)));
        for (const release of slots) release();
        s.knowledge.store.mounted = read;
        expect((await run(s, "true")).error).toBe(false);
        expect(scratchState(s).revision).toBe(1);
      } finally {
        for (const release of slots) release();
        s.db.close();
      }
    },
  );
});
