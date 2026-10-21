// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The project's channel in the feed's rows: the pinned row stays first
// under All and Chats whatever its activity, envelopes and later pages
// included; Runs and Flagged never take it; a search and Home place it
// by its activity like a chat.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyEnvelope,
  list,
  loadList,
  loadMore,
} from "../../../src/client/data/feed.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  listsOrigin,
  ordered,
  reconcile,
} from "../../../src/client/data/sessions-rows.ts";
import type { FeedRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const summary = (
  id: string,
  at: number,
  changes: Partial<SessionSummary> = {},
): SessionSummary => ({
  archived: null,
  attention: null,
  attentionReason: null,
  attentionSource: null,
  attentionBy: null,
  id,
  projectId: "p1",
  ownerId: "u1",
  agentId: "a1",
  origin: "chat",
  automationId: null,
  runSource: null,
  forkedFromId: null,
  title: `chat ${id}`,
  status: "done",
  revision: 1,
  createdAt: at,
  lastActivityAt: at,
  usage: null,
  disabledCapabilities: [],
  ...changes,
});

const channelOf = (at: number, changes: Partial<SessionSummary> = {}) =>
  summary("ch", at, {
    origin: "channel",
    ownerId: null,
    agentId: null,
    title: "finops",
    ...changes,
  });

const rowOf = (session: SessionSummary, pinned = false): FeedRow => ({
  session,
  ...(pinned ? { pinned: true } : {}),
  agent: null,
  agentRetired: false,
  send: null,
  sendAgent: null,
  last: null,
  automation: null,
  runBy: null,
  runs: null,
});

const envelope = (session: SessionSummary) => {
  const { session: _, runs: __, ...row } = rowOf(session);
  return {
    type: "session" as const,
    projectId: session.projectId,
    session,
    messages: [],
    send: null,
    row,
  };
};

const ids = () => list.value?.rows.map((r) => r.session.id);

describe("the pure order", () => {
  test("a pinned row goes first, an unpinned one by activity", () => {
    const rows = [
      rowOf(summary("a", 50)),
      rowOf(summary("r", 60, { status: "running" })),
      rowOf(channelOf(10), true),
    ];
    expect(ordered(rows).map((r) => r.session.id)).toEqual(["ch", "r", "a"]);
    rows[2] = rowOf(channelOf(10));
    expect(ordered(rows).map((r) => r.session.id)).toEqual(["r", "a", "ch"]);
  });

  test("Chats lists a channel, Runs never does", () => {
    expect(listsOrigin("chat", "channel")).toBe(true);
    expect(listsOrigin(null, "channel")).toBe(true);
    expect(listsOrigin("automation", "channel")).toBe(false);
    expect(listsOrigin("chat", "automation")).toBe(false);
  });

  test("an envelope keeps the pin and leaves the row first", () => {
    const rows = [rowOf(channelOf(10), true), rowOf(summary("a", 50))];
    const out = reconcile(
      rows,
      null,
      { origin: "chat", q: "" },
      envelope(channelOf(5, { revision: 2 })),
    );
    expect(out.reload).toBe(false);
    expect(out.rows.map((r) => [r.session.id, r.pinned ?? false])).toEqual([
      ["ch", true],
      ["a", false],
    ]);
  });
});

const realFetch = globalThis.fetch;
let user = 0;
let urls: string[] = [];
let answers: { rows: FeedRow[]; next: string | null }[] = [];

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

beforeEach(() => {
  user++;
  me.value = {
    id: `chan${user}`,
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
  urls = [];
  answers = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json(answers.shift() ?? { rows: [], next: null });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  me.value = undefined;
  await settle();
  globalThis.fetch = realFetch;
});

const PROJECT = { project: "p1", q: "" };

describe("a project's feed", () => {
  test.serial(
    "keeps the channel first under All through envelopes and pages",
    async () => {
      // the cursor is the last ordinary row's place
      answers.push({
        rows: [rowOf(channelOf(10), true), rowOf(summary("a", 50))],
        next: "0.50.a",
      });
      await loadList(PROJECT);
      expect(ids()).toEqual(["ch", "a"]);

      applyEnvelope(envelope(summary("n", 70)));
      expect(ids()).toEqual(["ch", "n", "a"]);
      // the channel's own activity never moves it down nor up
      applyEnvelope(envelope(channelOf(20, { revision: 2 })));
      expect(ids()).toEqual(["ch", "n", "a"]);
      expect(list.value?.rows[0]?.pinned).toBe(true);

      answers.push({ rows: [rowOf(summary("b", 40))], next: null });
      await loadMore();
      expect(ids()).toEqual(["ch", "n", "a", "b"]);
      expect(urls).toEqual([
        "/api/sessions?project=p1",
        "/api/sessions?project=p1&before=0.50.a",
      ]);
    },
  );

  test.serial(
    "keeps it first under Chats, its envelopes included",
    async () => {
      answers.push({
        rows: [rowOf(channelOf(10), true), rowOf(summary("a", 50))],
        next: null,
      });
      await loadList({ ...PROJECT, origin: "chat" });
      applyEnvelope(
        envelope(channelOf(80, { revision: 3, status: "running" })),
      );
      expect(ids()).toEqual(["ch", "a"]);
      expect(list.value?.rows[0]?.session.status).toBe("running");
    },
  );

  test.serial("leaves it out of Runs and Flagged", async () => {
    answers.push({ rows: [], next: null });
    await loadList({ ...PROJECT, origin: "automation" });
    applyEnvelope(envelope(channelOf(80, { revision: 3 })));
    expect(ids()).toEqual([]);
    answers.push({ rows: [], next: null });
    await loadList({ ...PROJECT, attention: true });
    applyEnvelope(envelope(channelOf(90, { revision: 4 })));
    expect(ids()).toEqual([]);
  });

  test.serial("places it by activity in a search", async () => {
    answers.push({
      rows: [
        rowOf(summary("a", 50, { title: "fin costs" })),
        rowOf(channelOf(10)),
      ],
      next: null,
    });
    await loadList({ ...PROJECT, q: "fin" });
    expect(ids()).toEqual(["a", "ch"]);
    applyEnvelope(envelope(channelOf(60, { revision: 2 })));
    expect(ids()).toEqual(["ch", "a"]);
    expect(list.value?.rows[0]?.pinned).toBeUndefined();
  });
});

describe("Home's feed", () => {
  test.serial("sorts each channel by activity like a chat", async () => {
    answers.push({
      rows: [rowOf(summary("a", 50)), rowOf(channelOf(30))],
      next: null,
    });
    await loadList({ project: null, q: "" });
    expect(ids()).toEqual(["a", "ch"]);
    applyEnvelope(envelope(channelOf(70, { revision: 2 })));
    expect(ids()).toEqual(["ch", "a"]);
    applyEnvelope(envelope(summary("a", 90, { revision: 2 })));
    expect(ids()).toEqual(["a", "ch"]);
  });
});
