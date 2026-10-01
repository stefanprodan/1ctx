// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home under a burst: many agents' sessions each changing a turn's
// worth of times, against a server that answers the first page after a
// delay. Counts the list reloads and checks the list ends as the
// server's first page.

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  applyEnvelope,
  list,
  loadList,
} from "../../../src/client/data/feed.ts";
import { TRAIL_MS } from "../../../src/client/data/flight.ts";
import { me } from "../../../src/client/data/me.ts";
import type { FeedRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const LATENCY = 25;
const PAGE = 50;
const AGENTS = 100;
const STEPS = 19;

function summary(changes: Partial<SessionSummary>): SessionSummary {
  return {
    archived: null,
    attention: null,
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
    createdAt: 1,
    lastActivityAt: 1,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  };
}

const rowOf = (session: SessionSummary): FeedRow => ({
  session,
  agent: "assistant",
  agentRetired: false,
  send: null,
  sendAgent: null,
  last: null,
  automation:
    session.automationId === null
      ? null
      : { id: session.automationId, name: "digest" },
  runBy: null,
  runs: session.automationId === null ? null : 1,
});

const order = (a: FeedRow, b: FeedRow) => {
  const ra = a.session.status === "running" ? 1 : 0;
  const rb = b.session.status === "running" ? 1 : 0;
  if (ra !== rb) return rb - ra;
  if (a.session.lastActivityAt !== b.session.lastActivityAt) {
    return b.session.lastActivityAt - a.session.lastActivityAt;
  }
  return a.session.id < b.session.id ? -1 : 1;
};

const cursor = (s: SessionSummary) =>
  `${s.status === "running" ? 1 : 0}.${s.lastActivityAt}.${s.id}`;

const realFetch = globalThis.fetch;
let user = 0;

beforeEach(() => {
  user++;
  me.value = {
    id: `burst${user}`,
    username: "casey",
    fullName: "Casey",
    role: "admin",
    mustChangePassword: false,
  };
});

afterEach(() => {
  me.value = undefined;
  globalThis.fetch = realFetch;
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type Shape = "chats" | "chats without rows" | "runs with no line held";

// every session of the server, the first page as it reads now, and the
// reloads it served
async function burst(shape: Shape) {
  const server = new Map<string, FeedRow>();
  for (let i = 0; i < 60; i++) {
    const id = `old${String(i).padStart(9, "0")}`;
    server.set(id, rowOf(summary({ id, lastActivityAt: 100 + i })));
  }
  const page = () => {
    const rows = [...server.values()].sort(order);
    const first = rows.slice(0, PAGE);
    return {
      rows: first,
      next: rows.length > PAGE ? cursor(first.at(-1)!.session) : null,
    };
  };
  let gets = 0;
  globalThis.fetch = ((url: string) => {
    if (!url.startsWith("/api/sessions")) throw new Error(url);
    gets++;
    return new Promise<Response>((resolve) => {
      // the server reads the page when it answers, as a busy one does
      setTimeout(() => resolve(Response.json(page())), LATENCY);
    });
  }) as unknown as typeof fetch;

  const first = loadList({ project: null, q: "" });
  jest.advanceTimersByTime(LATENCY);
  await flush();
  await first;
  gets = 0;

  const runs = shape === "runs with no line held";
  let now = 1_000;
  for (let step = 0; step < STEPS; step++) {
    for (let a = 0; a < AGENTS; a++) {
      now++;
      const id = `${runs ? "run" : "cht"}${String(a).padStart(9, "0")}`;
      const session = summary({
        id,
        agentId: `a${a}`,
        origin: runs ? "automation" : "chat",
        automationId: runs ? `au${a}` : null,
        status: step === STEPS - 1 ? "done" : "running",
        revision: step + 1,
        createdAt: 1_000 + a,
        lastActivityAt: now,
      });
      const { session: _, runs: __, ...row } = rowOf(session);
      server.set(id, rowOf(session));
      applyEnvelope({
        type: "session",
        projectId: "p1",
        session,
        messages: [],
        send: null,
        row: shape === "chats without rows" ? null : row,
      });
      // envelopes land about a millisecond apart
      jest.advanceTimersByTime(1);
      await flush();
    }
  }
  for (let t = 0; t < 40; t++) {
    jest.advanceTimersByTime(100);
    await flush();
  }
  return { gets, page: page() };
}

describe("Home under a burst of envelopes", () => {
  test.serial.each([
    "chats",
    "chats without rows",
    "runs with no line held",
  ] as const)("100 agents x 19 envelopes each, %s", async (shape) => {
    jest.useFakeTimers();
    try {
      const { gets, page } = await burst(shape);
      // before the list reconciled, each envelope was a reload: 1,900.
      // Now a chat's row is inserted, and what only the server can place
      // is one load at a time with a pause between: at most one per
      // pause over the burst's ~1.9 s
      const most = Math.ceil((AGENTS * STEPS) / TRAIL_MS) + 1;
      expect(gets).toBeLessThanOrEqual(shape === "chats" ? 0 : most);
      expect(list.value?.rows.slice(0, PAGE).map((r) => r.session.id)).toEqual(
        page.rows.map((r) => r.session.id),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
