// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  mergeNextPage,
  refreshHead,
  runOrder,
} from "../../../src/client/data/sessions-rows.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

function row(changes: Partial<SessionSummary> = {}): StreamRow {
  return {
    session: {
      id: "s1",
      projectId: "p1",
      ownerId: "u1",
      agentId: "a1",
      origin: "chat",
      automationId: null,
      runSource: null,
      forkedFromId: null,
      title: "Chat",
      status: "done",
      revision: 1,
      createdAt: 0,
      lastActivityAt: 0,
      usage: null,
      disabledCapabilities: [],
      ...changes,
    },
    agent: "assistant",
    send: null,
    last: null,
    automation: null,
    runBy: null,
    runs: null,
  };
}

const ids = (rows: StreamRow[]) => rows.map((r) => r.session.id);
const at = (id: string, lastActivityAt: number, revision = 1) =>
  row({ id, lastActivityAt, revision });

describe("mergeNextPage", () => {
  test("adds the page after the held rows, in the order", () => {
    const held = [at("a", 50), at("b", 40)];
    const merged = mergeNextPage(held, [at("c", 30), at("d", 30)]);
    expect(ids(merged)).toEqual(["a", "b", "c", "d"]);
  });

  test("keeps a held copy at a higher revision", () => {
    // an envelope moved b to the top after the page was asked
    const held = [at("b", 90, 3), at("a", 50)];
    const merged = mergeNextPage(held, [at("b", 40, 2), at("c", 30)]);
    expect(ids(merged)).toEqual(["b", "a", "c"]);
    expect(merged[0]?.session.revision).toBe(3);
  });

  test("takes the page's copy at a higher revision", () => {
    const held = [at("a", 50), at("b", 40, 1)];
    const merged = mergeNextPage(held, [at("b", 60, 2)]);
    expect(ids(merged)).toEqual(["b", "a"]);
    expect(merged[0]?.session.revision).toBe(2);
  });

  test("puts running rows first", () => {
    const held = [at("a", 50)];
    const merged = mergeNextPage(held, [
      row({ id: "r", status: "running", lastActivityAt: 1 }),
    ]);
    expect(ids(merged)).toEqual(["r", "a"]);
  });
});

describe("refreshHead", () => {
  // two pages held: a b on the first, c d on the second
  const held = [at("a", 50), at("b", 40), at("c", 30), at("d", 20)];

  test("keeps the held rows past the answer's last row", () => {
    const fresh = refreshHead(
      held,
      { rows: [at("n", 60), at("a", 50)], next: "cursor-a" },
      "cursor-d",
    );
    expect(ids(fresh.rows)).toEqual(["n", "a", "b", "c", "d"]);
    // a tail is kept, so the held next pages past it
    expect(fresh.next).toBe("cursor-d");
  });

  test("a page-2 row that moved into the head takes the head's place", () => {
    const fresh = refreshHead(
      held,
      { rows: [at("c", 70, 2), at("a", 50)], next: "cursor-a" },
      "cursor-d",
    );
    expect(ids(fresh.rows)).toEqual(["c", "a", "b", "d"]);
    expect(fresh.rows[0]?.session.revision).toBe(2);
  });

  test("a held copy at a higher revision keeps its word in the head", () => {
    const newer = [at("a", 80, 5), ...held.slice(1)];
    const fresh = refreshHead(
      newer,
      { rows: [at("a", 50, 4), at("b", 40)], next: "cursor-b" },
      "cursor-d",
    );
    expect(fresh.rows[0]?.session.revision).toBe(5);
    expect(ids(fresh.rows)).toEqual(["a", "b", "c", "d"]);
  });

  test("takes the answer's next when no tail is kept", () => {
    const first = [at("a", 50), at("b", 40)];
    const fresh = refreshHead(
      first,
      { rows: [at("n", 60), at("a", 50), at("b", 40)], next: "cursor-b" },
      "cursor-b0",
    );
    expect(ids(fresh.rows)).toEqual(["n", "a", "b"]);
    expect(fresh.next).toBe("cursor-b");
  });

  test("an answer with no next is the whole list", () => {
    const fresh = refreshHead(held, { rows: [at("a", 50)], next: null }, "x");
    expect(ids(fresh.rows)).toEqual(["a"]);
    expect(fresh.next).toBeNull();
  });

  test("drops a held row at or above the answer's last row it lacks", () => {
    // b was deleted: the head no longer lists it
    const fresh = refreshHead(
      held,
      { rows: [at("a", 50), at("c", 30)], next: "cursor-c" },
      "cursor-d",
    );
    expect(ids(fresh.rows)).toEqual(["a", "c", "d"]);
  });

  test("the runs' order has no rank", () => {
    const runs = [
      row({ id: "r", status: "running", lastActivityAt: 90 }),
      at("a", 50),
      at("b", 40),
    ];
    const fresh = refreshHead(
      runs,
      {
        rows: [row({ id: "r", status: "done", lastActivityAt: 95 })],
        next: "cursor-r",
      },
      "cursor-b",
      runOrder,
    );
    expect(ids(fresh.rows)).toEqual(["r", "a", "b"]);
  });
});
