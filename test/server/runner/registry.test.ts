// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { TooManyRequests } from "../../../src/server/lib/errors.ts";
import type { SendCaps } from "../../../src/server/limits/index.ts";
import {
  type ActiveSend,
  Registry,
  RunCapacity,
} from "../../../src/server/runner/index.ts";
import type { SendKind } from "../../../src/shared/words.ts";

let next = 0;
// a user-started send, or a scheduled run when startedBy is null
const send = (
  kind: SendKind,
  startedBy: string | null,
  projectId: string,
): ActiveSend =>
  ({
    sessionId: `s${++next}`,
    kind,
    startedBy,
    projectId,
    terminal: null,
    policy: { userId: startedBy ?? "owner", fullName: startedBy ?? "owner" },
  }) as unknown as ActiveSend;

const fill = (
  registry: Registry,
  n: number,
  startedBy: string | null,
  projectId: string,
  kind: SendKind = startedBy === null ? "run" : "chat",
) =>
  Array.from({ length: n }, () => {
    const one = send(kind, startedBy, projectId);
    registry.set(one);
    return one;
  });

const caps = (
  sendsPerUser: number,
  sendsPerProject: number,
  sendsRunning: number,
): SendCaps => ({ sendsPerUser, sendsPerProject, sendsRunning });

const DEFAULTS = caps(4, 16, 64);

function refusal(admit: () => void): Error | null {
  try {
    admit();
  } catch (err) {
    return err as Error;
  }
  return null;
}

const USER = "You have 4 chats and runs going. Wait for one to end.";
const PROJECT =
  "This project has 16 chats and runs going. Try again in a moment.";
const PROCESS = "Too many chats and runs are going. Try again in a moment.";

const user = (userId: string, projectId = "p1") => ({ userId, projectId });
const scheduled = (projectId = "p1") => ({ userId: null, projectId });

describe("admission", () => {
  test.each(["chat", "compact", "run"] as const)(
    "a user's %s sends count against their cap in every project",
    (kind) => {
      const registry = new Registry();
      fill(registry, 2, "u1", "p1", kind);
      fill(registry, 2, "u1", "p2", kind);
      const err = refusal(() =>
        registry.admit("new", user("u1", "p3"), DEFAULTS),
      );
      expect(err).toBeInstanceOf(TooManyRequests);
      expect(err).not.toBeInstanceOf(RunCapacity);
      expect(err?.message).toBe(USER);
      expect(() =>
        registry.admit("new", user("u2", "p1"), DEFAULTS),
      ).not.toThrow();
    },
  );

  test("scheduled runs count against no user", () => {
    const registry = new Registry();
    fill(registry, 3, "u1", "p1");
    fill(registry, 8, null, "p1");
    expect(() =>
      registry.admit("new", user("u1", "p1"), DEFAULTS),
    ).not.toThrow();
    // an owner at their cap does not hold up the project's schedules
    fill(registry, 1, "u1", "p1");
    expect(() =>
      registry.admit("new", scheduled("p1"), DEFAULTS),
    ).not.toThrow();
  });

  test("a full project refuses every kind there and nothing elsewhere", () => {
    const registry = new Registry();
    fill(registry, 4, "u1", "p1");
    fill(registry, 4, "u2", "p1");
    fill(registry, 8, null, "p1");
    expect(
      refusal(() => registry.admit("new", user("u3"), DEFAULTS))?.message,
    ).toBe(PROJECT);
    const run = refusal(() => registry.admit("new", scheduled(), DEFAULTS));
    expect(run).toBeInstanceOf(RunCapacity);
    expect((run as RunCapacity).cap).toBe("project");
    expect(run?.message).toBe(PROJECT);
    expect(() =>
      registry.admit("new", user("u3", "p2"), DEFAULTS),
    ).not.toThrow();
    expect(() =>
      registry.admit("new", scheduled("p2"), DEFAULTS),
    ).not.toThrow();
  });

  test("a full process refuses every kind", () => {
    const registry = new Registry();
    for (let p = 0; p < 4; p++) fill(registry, 16, `u${p}`, `p${p}`, "chat");
    const chat = refusal(() =>
      registry.admit("new", user("new", "px"), DEFAULTS),
    );
    expect(chat).not.toBeInstanceOf(RunCapacity);
    expect(chat?.message).toBe(PROCESS);
    const run = refusal(() => registry.admit("new", scheduled("px"), DEFAULTS));
    expect((run as RunCapacity).cap).toBe("process");
    expect(run?.message).toBe(PROCESS);
  });

  test("the refusal names the narrowest full cap", () => {
    const registry = new Registry();
    const tight = caps(2, 4, 4);
    fill(registry, 2, "u1", "p1");
    fill(registry, 2, "u2", "p1");
    // user, project and process are all full: the user's is named
    expect(
      refusal(() => registry.admit("new", user("u1"), tight))?.message,
    ).toBe("You have 2 chats and runs going. Wait for one to end.");
    // project and process full: the project's
    expect(
      refusal(() => registry.admit("new", user("u3"), tight))?.message,
    ).toBe("This project has 4 chats and runs going. Try again in a moment.");
    const run = refusal(() => registry.admit("new", scheduled(), tight));
    expect((run as RunCapacity).cap).toBe("project");
    // the process alone
    expect(
      refusal(() => registry.admit("new", user("u3", "p2"), tight))?.message,
    ).toBe(PROCESS);
    expect(
      (
        refusal(() =>
          registry.admit("new", scheduled("p2"), tight),
        ) as RunCapacity
      ).cap,
    ).toBe("process");
  });

  test("scheduled runs hold at most three quarters of a project, users the rest", () => {
    const registry = new Registry();
    fill(registry, 11, null, "p1");
    expect(() => registry.admit("new", scheduled(), DEFAULTS)).not.toThrow();
    fill(registry, 1, null, "p1");
    const run = refusal(() => registry.admit("new", scheduled(), DEFAULTS));
    expect((run as RunCapacity).cap).toBe("project");
    for (let i = 0; i < 4; i++) {
      expect(() =>
        registry.admit("new", user(`u${i}`), DEFAULTS),
      ).not.toThrow();
      fill(registry, 1, `u${i}`, "p1");
    }
    expect(
      refusal(() => registry.admit("new", user("u9"), DEFAULTS))?.message,
    ).toBe(PROJECT);
  });

  test("scheduled runs hold at most 48 of 64 in the process and a chat still starts", () => {
    const registry = new Registry();
    for (let p = 0; p < 4; p++) fill(registry, 12, null, `p${p}`);
    const run = refusal(() => registry.admit("new", scheduled("p9"), DEFAULTS));
    expect((run as RunCapacity).cap).toBe("process");
    expect(() =>
      registry.admit("new", user("u1", "p0"), DEFAULTS),
    ).not.toThrow();
  });

  test("at the floor of 4, three runs start and a chat still does", () => {
    const registry = new Registry();
    const floor = caps(1, 4, 4);
    for (let i = 0; i < 3; i++) {
      expect(() => registry.admit("new", scheduled(), floor)).not.toThrow();
      fill(registry, 1, null, "p1");
    }
    expect(
      (
        refusal(() =>
          registry.admit("new", scheduled("p2"), floor),
        ) as RunCapacity
      ).cap,
    ).toBe("process");
    expect(() => registry.admit("new", user("u1"), floor)).not.toThrow();
  });

  test("the user's refusal counts what they have going, not the cap", () => {
    const registry = new Registry();
    fill(registry, 1, "u1", "p1");
    expect(
      refusal(() => registry.admit("new", user("u1"), caps(1, 16, 64)))
        ?.message,
    ).toBe("You have 1 chat or run going. Wait for one to end.");
    fill(registry, 5, "u1", "p2");
    expect(
      refusal(() => registry.admit("new", user("u1"), caps(4, 16, 64)))
        ?.message,
    ).toBe("You have 6 chats and runs going. Wait for one to end.");
  });

  test("the caps are read at each admission and a lowered one stops nothing", () => {
    const registry = new Registry();
    const held = fill(registry, 3, "u1", "p1");
    expect(() => registry.admit("new", user("u1"), DEFAULTS)).not.toThrow();
    expect(
      refusal(() => registry.admit("new", user("u1"), caps(1, 16, 64))),
    ).not.toBeNull();
    expect(registry.values()).toEqual(held);
    expect(registry.free(held[0]!)).toBe(true);
    expect(() =>
      registry.admit("new", user("u1"), caps(3, 16, 64)),
    ).not.toThrow();
  });

  test("a held session is the lock holder's conflict for any starter", () => {
    const registry = new Registry();
    const [one] = fill(registry, 1, "u1", "p1");
    for (const who of [user("u2"), scheduled()]) {
      const err = refusal(() => registry.admit(one!.sessionId, who, DEFAULTS));
      expect(err?.message).toBe("u1 is sending");
    }
  });

  test("running counts chats, runs, scheduled runs and full projects", () => {
    const registry = new Registry();
    fill(registry, 2, "u1", "p1", "chat");
    fill(registry, 1, "u1", "p1", "compact");
    fill(registry, 1, "u2", "p2", "run");
    fill(registry, 3, null, "p2");
    expect(registry.running(4)).toEqual({
      chats: 3,
      runs: 4,
      scheduled: 3,
      projectsFull: 1,
    });
  });
});
