// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { TooManyRequests } from "../../../src/server/lib/errors.ts";
import {
  type ActiveSend,
  Registry,
  RunCapacity,
} from "../../../src/server/runner/index.ts";
import { CHAT_POOL, runPool } from "../../../src/server/runner/registry.ts";
import type { SendKind } from "../../../src/shared/words.ts";

let next = 0;
const send = (kind: SendKind, userId: string): ActiveSend =>
  ({
    sessionId: `s${++next}`,
    kind,
    terminal: null,
    policy: { userId, fullName: userId },
  }) as unknown as ActiveSend;

const fill = (registry: Registry, kind: SendKind, userId: string, n: number) =>
  Array.from({ length: n }, () => {
    const one = send(kind, userId);
    registry.set(one);
    return one;
  });

const runs = (perUser: number, running: number) =>
  runPool({ runsPerUser: perUser, runsRunning: running });

function refusal(admit: () => void): unknown {
  try {
    admit();
  } catch (err) {
    return err;
  }
  return null;
}

describe("the registry's pools", () => {
  test("a chat is admitted with four runs of its user running", () => {
    const registry = new Registry({ running: 32, perUser: 4 });
    fill(registry, "run", "u1", 4);
    expect(() => registry.admit("new", "u1", CHAT_POOL)).not.toThrow();
    fill(registry, "chat", "u1", 3);
    fill(registry, "compact", "u1", 1);
    // compact counts as a chat
    const err = refusal(() => registry.admit("new", "u1", CHAT_POOL));
    expect(err).toBeInstanceOf(TooManyRequests);
    expect(err).not.toBeInstanceOf(RunCapacity);
    expect((err as Error).message).toBe(
      "4 of your chats are running; wait for one",
    );
  });

  test("a run is admitted with the user's chats full", () => {
    const registry = new Registry({ running: 4, perUser: 4 });
    fill(registry, "chat", "u1", 4);
    expect(() => registry.admit("new", "u1", runs(4, 32))).not.toThrow();
  });

  test("a full run pool says which one", () => {
    const registry = new Registry();
    fill(registry, "run", "u1", 2);
    const user = refusal(() => registry.admit("new", "u1", runs(2, 32)));
    expect(user).toBeInstanceOf(RunCapacity);
    expect((user as RunCapacity).pool).toBe("user");
    expect((user as RunCapacity).status).toBe(429);
    expect((user as Error).message).toBe(
      "2 of your tasks are running; wait for one",
    );
    // another user is not bound by u1's count
    expect(() => registry.admit("new", "u2", runs(2, 32))).not.toThrow();
    const full = refusal(() => registry.admit("new", "u2", runs(2, 2)));
    expect((full as RunCapacity).pool).toBe("process");
    expect((full as Error).message).toBe(
      "too many tasks running; try again in a moment",
    );
  });

  test("the caps are read at each admission and a lowered one stops nothing", () => {
    const registry = new Registry();
    const held = fill(registry, "run", "u1", 3);
    expect(() => registry.admit("new", "u1", runs(4, 32))).not.toThrow();
    expect(
      refusal(() => registry.admit("new", "u1", runs(1, 32))),
    ).toBeInstanceOf(RunCapacity);
    expect(registry.values()).toEqual(held);
    expect(registry.free(held[0]!)).toBe(true);
    expect(() => registry.admit("new", "u1", runs(3, 32))).not.toThrow();
  });

  test("a held session is the lock holder's conflict in either pool", () => {
    const registry = new Registry();
    const [one] = fill(registry, "run", "u1", 1);
    for (const pool of [CHAT_POOL, runs(4, 32)]) {
      const err = refusal(() => registry.admit(one!.sessionId, "u2", pool));
      expect((err as Error).message).toBe("u1 is sending");
    }
  });
});
