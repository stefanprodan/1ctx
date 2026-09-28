// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, test } from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import {
  instanceSlot,
  readSlot,
  usageSlot,
} from "../../../src/client/data/slot.ts";

const realFetch = globalThis.fetch;

const user = (id: string) => ({
  id,
  username: id,
  fullName: id,
  role: "admin" as const,
  mustChangePassword: false,
});

// each read waits for its own release, so a test picks the order
function held<T>() {
  const calls: {
    id: string;
    answer: (value: T) => void;
    fail: () => void;
  }[] = [];
  const read = (id: string) =>
    new Promise<T>((answer, reject) => {
      calls.push({ id, answer, fail: () => reject(new Error("no")) });
    });
  return { calls, read };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  me.value = user("u1");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  me.value = undefined;
});

test.serial("each id keeps its answer, and a failure is null", async () => {
  const { calls, read } = held<number>();
  const slot = readSlot(read);
  expect(slot.valueFor("a")).toBeUndefined();
  const a = slot.load("a");
  const b = slot.load("b");
  calls[0]!.answer(1);
  calls[1]!.fail();
  await Promise.all([a, b]);
  expect(slot.valueFor("a")).toBe(1);
  expect(slot.valueFor("b")).toBeNull();
  expect(slot.valueFor("c")).toBeUndefined();
});

test.serial(
  "a revisit keeps the held answer until the new one lands",
  async () => {
    const { calls, read } = held<number>();
    const slot = readSlot(read);
    const first = slot.load("a");
    calls[0]!.answer(1);
    await first;
    const again = slot.load("a");
    expect(slot.valueFor("a")).toBe(1);
    calls[1]!.answer(2);
    await again;
    expect(slot.valueFor("a")).toBe(2);
  },
);

test.serial("only the latest read of an id lands", async () => {
  const { calls, read } = held<number>();
  const slot = readSlot(read);
  const older = slot.load("a");
  const newer = slot.load("a");
  calls[1]!.answer(2);
  await newer;
  calls[0]!.answer(1);
  await older;
  expect(slot.valueFor("a")).toBe(2);
});

test.serial(
  "a user change drops the answers and a read in flight",
  async () => {
    const { calls, read } = held<number>();
    const slot = readSlot(read);
    const done = slot.load("a");
    calls[0]!.answer(1);
    await done;
    const late = slot.load("b");
    me.value = user("u2");
    expect(slot.valueFor("a")).toBeUndefined();
    calls[1]!.answer(3);
    await late;
    expect(slot.valueFor("b")).toBeUndefined();
  },
);

test.serial(
  "a usage slot reads its address; the instance one has no id",
  async () => {
    const urls: string[] = [];
    globalThis.fetch = ((url: string) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ calls: 4 }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    const slot = usageSlot<{ calls: number }>(
      (id) => `/api/mcp/${encodeURIComponent(id)}/usage`,
    );
    await slot.load("a b");
    expect(slot.valueFor("a b")).toEqual({ calls: 4 });
    const all = instanceSlot<{ calls: number }>("/api/mcp/usage");
    expect(all.value()).toBeUndefined();
    await all.load();
    await settle();
    expect(all.value()).toEqual({ calls: 4 });
    expect(urls).toEqual(["/api/mcp/a%20b/usage", "/api/mcp/usage"]);
  },
);
