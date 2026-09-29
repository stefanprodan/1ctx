// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's Not sent card: it shows only while the user has one, each row
// leads to its chat, Discard all empties it, and a queue change in a
// chat it lists reads it again only while the card is on screen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { me } from "../../../src/client/data/me.ts";
import {
  discardNotSent,
  loadNotSent,
  noteWaits,
  notSent,
  onNotSentSocket,
  watchNotSent,
} from "../../../src/client/data/not-sent.ts";
import { NotSent } from "../../../src/client/views/home/NotSent.tsx";
import type { NotSentRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";

const row = (changes: Partial<NotSentRow> = {}): NotSentRow => ({
  id: "q1",
  sessionId: "s1",
  title: "Which pods restarted",
  project: "personal",
  agent: "assistant",
  line: "and the logs too",
  reason: "expired",
  changedAt: 1_000,
  ...changes,
});

const summary = (changes: Partial<SessionSummary> = {}): SessionSummary => ({
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
  revision: 4,
  createdAt: 10,
  lastActivityAt: 20,
  usage: null,
  disabledCapabilities: [],
  ...changes,
});

const envelope = (id: string, messages: never[] = []) => ({
  type: "session" as const,
  row: null,
  projectId: "p1",
  session: summary({ id }),
  messages,
  send: null,
});

const realFetch = globalThis.fetch;
let calls: string[] = [];
let answer: (method: string) => Response;
let user = 0;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  // a new user each test, so nothing held carries over
  user++;
  me.value = {
    id: `u${user}`,
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
  calls = [];
  answer = () => Response.json({ rows: [row()] });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    return answer(method);
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  me.value = undefined;
  await settle();
  globalThis.fetch = realFetch;
});

describe("Home's Not sent card", () => {
  test.serial(
    "shows only while there is one, each row leading to its chat",
    () => {
      expect(render(<NotSent now={61_000} />)).toBe("");
      notSent.value = [];
      expect(render(<NotSent now={61_000} />)).toBe("");
      notSent.value = [row()];
      const html = render(<NotSent now={61_000} />);
      expect(html).toContain(">Not sent<");
      expect(html).toContain('class="rows-count" aria-live="polite">1<');
      expect(html).toContain(">Discard all<");
      expect(html).toContain('href="/chat/s1"');
      expect(html).toContain("and the logs too");
      expect(html).toMatch(
        /#personal<\/span> · <span class="stream-author">@assistant<\/span> · <span class="stream-bad">waited too long</,
      );
      expect(html).toContain("1m ago");
      // a message of files alone is named by its chat
      notSent.value = [row({ line: "" })];
      expect(render(<NotSent now={61_000} />)).toContain(
        "Which pods restarted",
      );
    },
  );

  test.serial("Discard all empties it and reads it again", async () => {
    await loadNotSent();
    answer = (method) =>
      method === "DELETE"
        ? Response.json({ deleted: 1 })
        : Response.json({ rows: [] });
    await discardNotSent();
    expect(calls).toEqual([
      "GET /api/me/not-sent",
      "DELETE /api/me/not-sent",
      "GET /api/me/not-sent",
    ]);
    expect(notSent.value).toEqual([]);
  });

  test.serial(
    "a queue change in a chat it lists reads it again while watched",
    async () => {
      await loadNotSent();
      // not on screen: nothing is read
      onNotSentSocket(envelope("s1"));
      await settle();
      expect(calls).toHaveLength(1);
      const stop = watchNotSent();
      try {
        onNotSentSocket(envelope("s1"));
        // a chat it does not list and where nothing of the user's waits
        onNotSentSocket(envelope("s9"));
        await settle();
        expect(calls).toHaveLength(2);
      } finally {
        stop();
      }
    },
  );

  test.serial(
    "a chat where the user's message waits is watched too",
    async () => {
      answer = () => Response.json({ rows: [] });
      await loadNotSent();
      const stop = watchNotSent();
      try {
        noteWaits("s7", [{ author: { id: "someone" } }]);
        onNotSentSocket(envelope("s7"));
        await settle();
        expect(calls).toHaveLength(1);
        noteWaits("s7", [{ author: { id: `u${user}` } }]);
        onNotSentSocket(envelope("s7"));
        await settle();
        expect(calls).toHaveLength(2);
      } finally {
        stop();
      }
    },
  );
});
