// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home's Not sent card: it shows only while the user has one, each row
// leads to its chat, Discard all names the rows it shows, and the
// user's notSent event reads it again, folded, only while the card is
// on screen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { me } from "../../../src/client/data/me.ts";
import {
  discardNotSent,
  loadNotSent,
  notSent,
  onNotSentSocket,
  watchNotSent,
} from "../../../src/client/data/not-sent.ts";
import { NotSent } from "../../../src/client/views/home/NotSent.tsx";
import type { NotSentRow } from "../../../src/shared/api/sessions.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

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

const notSentEvent = (sessionId: string): SocketEvent => ({
  type: "notSent",
  projectId: "p1",
  sessionId,
  revision: 4,
  rows: [],
});

const realFetch = globalThis.fetch;
let calls: { call: string; body: unknown }[] = [];
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
    calls.push({
      call: `${method} ${url}`,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
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
        /#personal<\/span> · <span class="feed-author">@assistant<\/span> · <span class="feed-bad">waited too long</,
      );
      expect(html).toContain("1m ago");
      // a message of files alone is named by its chat
      notSent.value = [row({ line: "" })];
      expect(render(<NotSent now={61_000} />)).toContain(
        "Which pods restarted",
      );
    },
  );

  test.serial("Discard all names the rows it shows", async () => {
    answer = () =>
      Response.json({ rows: [row(), row({ id: "q2", sessionId: "s2" })] });
    await loadNotSent();
    answer = (method) =>
      method === "DELETE"
        ? Response.json({ deleted: 2 })
        : Response.json({ rows: [] });
    await discardNotSent();
    expect(calls).toEqual([
      { call: "GET /api/me/not-sent", body: undefined },
      { call: "DELETE /api/me/not-sent", body: { ids: ["q1", "q2"] } },
      { call: "GET /api/me/not-sent", body: undefined },
    ]);
    expect(notSent.value).toEqual([]);
  });

  test.serial(
    "the user's notSent event reads it again while watched, folded",
    async () => {
      await loadNotSent();
      // not on screen: nothing is read
      onNotSentSocket(notSentEvent("s9"));
      await settle();
      expect(calls).toHaveLength(1);
      const stop = watchNotSent();
      try {
        onNotSentSocket(notSentEvent("s9"));
        onNotSentSocket(notSentEvent("s8"));
        onNotSentSocket(notSentEvent("s7"));
        await settle();
        // one read now, the rest folded into one trailing read
        expect(calls).toHaveLength(2);
      } finally {
        stop();
      }
    },
  );

  test.serial("a chat it lists deleted reads it again", async () => {
    await loadNotSent();
    const stop = watchNotSent();
    try {
      onNotSentSocket({ type: "deleted", projectId: "p1", sessionId: "s9" });
      await settle();
      expect(calls).toHaveLength(1);
      onNotSentSocket({ type: "deleted", projectId: "p1", sessionId: "s1" });
      await settle();
      expect(calls).toHaveLength(2);
    } finally {
      stop();
    }
  });
});
