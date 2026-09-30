// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The queued message's routes: who may edit and remove one, who sees
// which rows in the detail, Home's not-sent list and Discard all, the
// hourly sweep of old not-sent rows and the admin's load.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { NOT_SENT_KEPT_MS } from "../../../src/server/sessions/index.ts";
import {
  MAX_DISCARD_IDS,
  parseDiscardNotSent,
} from "../../../src/server/sessions/parse.ts";
import type { QueuedMessage } from "../../../src/shared/contracts/session.ts";
import {
  collectLogs,
  hashPassword,
  type TestClient,
} from "../../helpers/app.ts";
import { settleRun } from "../../helpers/automations.ts";
import { type ChatApp, chatApp, startChat } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";

async function user(chat: ChatApp, username: string) {
  const row = chat.app.createUser({
    username,
    fullName: username,
    email: `${username}@example.com`,
    role: "member",
    passwordHash: await hashPassword("pw"),
    mustChangePassword: false,
    now: chat.app.now.value,
  });
  const client = chat.app.client();
  await client.login(username, "pw");
  return { id: row.id, client };
}

async function queue(
  client: TestClient,
  sessionId: string,
  message: string,
): Promise<QueuedMessage> {
  const response = await client.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message } },
  );
  expect(response.status).toBe(202);
  return (await response.json()).queued;
}

// casey's running team chat, dana a member beside them, eve outside
async function setup(options: Parameters<typeof chatApp>[0] = {}) {
  const chat = await chatApp(options);
  const dana = await user(chat, "dana");
  const eve = await user(chat, "eve");
  const team = await createTeam(chat.admin, "ops", [chat.memberId, dana.id]);
  const started = await startChat(chat, "first", chat.member, team.id);
  return { chat, dana, eve, team, ...started };
}

const edit = (client: TestClient, sessionId: string, row: QueuedMessage) =>
  client.call("PATCH", `/api/sessions/${sessionId}/queued/${row.id}`, {
    body: { message: "edited", revision: row.revision },
  });
const remove = (client: TestClient, sessionId: string, row: QueuedMessage) =>
  client.call("DELETE", `/api/sessions/${sessionId}/queued/${row.id}`, {
    body: { revision: row.revision },
  });

const notSend = (chat: ChatApp, row: QueuedMessage) =>
  chat.app.sessions.queue.notSend(
    [{ id: row.id, revision: row.revision }],
    "expired",
    chat.app.now.value,
  );

describe("a queued message's routes", () => {
  test("only its author edits or removes it", async () => {
    const { chat, dana, eve, sessionId, script } = await setup();
    try {
      const row = await queue(chat.member, sessionId, "mine");
      for (const [client, status] of [
        [dana.client, 403],
        [chat.admin, 403],
        [eve.client, 404],
      ] as const) {
        expect((await edit(client, sessionId, row)).status).toBe(status);
        expect((await remove(client, sessionId, row)).status).toBe(status);
      }
      const edited = await edit(chat.member, sessionId, row);
      expect(edited.status).toBe(200);
      const { queued } = await edited.json();
      expect(queued).toMatchObject({ text: "edited", revision: 1 });
      expect((await remove(chat.member, sessionId, row)).status).toBe(409);
      const removed = await remove(chat.member, sessionId, queued);
      expect(removed.status).toBe(200);
      // the caller's queue at the revision the remove made
      expect(await removed.json()).toEqual({
        queue: [],
        revision: chat.app.sessions.byId(sessionId)!.revision,
      });
      expect(chat.app.sessions.queue.waiting(sessionId)).toEqual([]);
      const bad = await chat.member.call(
        "PATCH",
        `/api/sessions/${sessionId}/queued/${row.id}`,
        { body: { message: "x", revision: -1 } },
      );
      expect(bad.status).toBe(400);
      script.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a removed member's rows go and their routes are a 404", async () => {
    const { chat, dana, team, sessionId, script } = await setup();
    try {
      const row = await queue(dana.client, sessionId, "from dana");
      const before = chat.app.sessions.byId(sessionId)!.revision;
      const removed = await chat.admin.call(
        "DELETE",
        `/api/projects/${team.id}/members/${dana.id}`,
      );
      expect(removed.status).toBe(200);
      expect(chat.app.sessions.queue.waiting(sessionId)).toEqual([]);
      expect(chat.app.sessions.byId(sessionId)!.revision).toBe(before + 1);
      expect((await edit(dana.client, sessionId, row)).status).toBe(404);
      expect((await remove(dana.client, sessionId, row)).status).toBe(404);
      script.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "the detail shows every queued row and a not-sent one to its author",
    async () => {
      const { chat, dana, sessionId, script } = await setup();
      try {
        const mine = await queue(chat.member, sessionId, "mine");
        const hers = await queue(dana.client, sessionId, "hers");
        notSend(chat, mine);
        // the author reads their row whole, no one else reads it
        const one = (client: TestClient, row: QueuedMessage) =>
          client.call("GET", `/api/sessions/${sessionId}/queued/${row.id}`);
        const whole = await one(chat.member, mine);
        expect(whole.status).toBe(200);
        expect((await whole.json()).queued).toMatchObject({
          id: mine.id,
          text: "mine",
          cut: false,
        });
        expect((await one(dana.client, mine)).status).toBe(403);
        expect((await one(chat.admin, mine)).status).toBe(403);
        const read = async (client: TestClient) =>
          (
            (await (
              await client.call("GET", `/api/sessions/${sessionId}`)
            ).json()) as { queued: QueuedMessage[] }
          ).queued.map((row) => [row.id, row.state, row.reason]);
        expect(await read(chat.member)).toEqual([
          [mine.id, "not-sent", "expired"],
          [hers.id, "queued", null],
        ]);
        expect(await read(dana.client)).toEqual([[hers.id, "queued", null]]);
        expect(await read(chat.admin)).toEqual([[hers.id, "queued", null]]);
        // a not-sent row takes no edit, and its author discards it, which
        // tells their own tabs alone
        expect((await edit(chat.member, sessionId, mine)).status).toBe(409);
        const events: BusEvent[] = [];
        const unsubscribe = subscribe((event) => {
          if (event.type === "queue.mine" || event.type === "queue.changed") {
            events.push(event);
          }
        }, silent);
        const discarded = await remove(chat.member, sessionId, {
          ...mine,
          revision: 1,
        });
        unsubscribe();
        expect(discarded.status).toBe(200);
        expect(events.map((event) => [event.type, event.data])).toEqual([
          [
            "queue.mine",
            expect.objectContaining({ userId: chat.memberId, rows: [] }),
          ],
        ]);
        expect((await remove(dana.client, sessionId, hers)).status).toBe(200);
        script.reply("done");
        await settleRun(chat, sessionId);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "Home lists the caller's not-sent rows and Discard all empties them",
    async () => {
      const { chat, dana, sessionId, script } = await setup();
      try {
        const mine = await queue(
          chat.member,
          sessionId,
          "  \n# Check the logs\nand more",
        );
        const waiting = await queue(chat.member, sessionId, "still waiting");
        const hers = await queue(dana.client, sessionId, "hers");
        notSend(chat, mine);
        notSend(chat, hers);
        const listed = await chat.member.call("GET", "/api/me/not-sent");
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({
          rows: [
            {
              id: mine.id,
              sessionId,
              title: "first",
              project: "ops",
              agent: "coder",
              line: "Check the logs",
              reason: "expired",
              changedAt: chat.app.now.value,
            },
          ],
        });
        const before = chat.app.sessions.byId(sessionId)!.revision;
        // only the ids named that are the caller's and not sent go, which
        // tells their own tabs alone
        const events: BusEvent[] = [];
        const unsubscribe = subscribe((event) => {
          if (event.type === "queue.mine" || event.type === "queue.changed") {
            events.push(event);
          }
        }, silent);
        const discarded = await chat.member.call("DELETE", "/api/me/not-sent", {
          body: { ids: [mine.id, waiting.id, hers.id] },
        });
        unsubscribe();
        expect(discarded.status).toBe(200);
        expect(events.map((event) => [event.type, event.data])).toEqual([
          [
            "queue.mine",
            expect.objectContaining({
              userId: chat.memberId,
              sessionId,
              rows: [],
            }),
          ],
        ]);
        expect(await discarded.json()).toEqual({ deleted: 1 });
        expect(chat.app.sessions.byId(sessionId)!.revision).toBe(before + 1);
        expect(
          await (await chat.member.call("GET", "/api/me/not-sent")).json(),
        ).toEqual({ rows: [] });
        // a row in a project the caller no longer sees is neither listed
        // nor discarded
        const theirs = await startChat(
          chat,
          "theirs",
          chat.admin,
          chat.app.projects.personal(chat.adminId)!.id,
        );
        const elsewhere = chat.app.sessions.queue.insert({
          sessionId: theirs.sessionId,
          authorId: chat.memberId,
          text: "unseen",
          now: chat.app.now.value,
        });
        chat.app.sessions.queue.notSend(
          [elsewhere],
          "expired",
          chat.app.now.value,
        );
        const unseen = await chat.member.call("DELETE", "/api/me/not-sent", {
          body: { ids: [elsewhere.id] },
        });
        expect(await unseen.json()).toEqual({ deleted: 0 });
        theirs.script.reply("done");
        await settleRun(chat, theirs.sessionId);
        // the caller's queued row and another author's stay
        expect(
          chat.app.sessions.queue.ofChat(sessionId, dana.id).map((r) => r.id),
        ).toEqual([waiting.id, hers.id]);
        expect(
          (await (await dana.client.call("GET", "/api/me/not-sent")).json())
            .rows,
        ).toHaveLength(1);
        await chat.member.call(
          "DELETE",
          `/api/sessions/${sessionId}/queued/${waiting.id}`,
          { body: { revision: 0 } },
        );
        script.reply("done");
        await settleRun(chat, sessionId);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test.serial(
    "the hourly sweep deletes not-sent rows after seven days",
    async () => {
      const logs = collectLogs();
      const { chat, sessionId, script } = await setup({
        logFactory: logs.logFactory,
      });
      try {
        const old = await queue(chat.member, sessionId, "old");
        notSend(chat, old);
        script.reply("done");
        await settleRun(chat, sessionId);
        chat.app.now.value += NOT_SENT_KEPT_MS;
        chat.app.sweep();
        expect(chat.app.sessions.queue.byId(old.id)).not.toBeNull();
        chat.app.now.value += 1;
        const told: BusEvent[] = [];
        const unsubscribe = subscribe((event) => {
          if (event.type === "queue.mine") told.push(event);
        }, silent);
        chat.app.sweep();
        unsubscribe();
        expect(chat.app.sessions.queue.byId(old.id)).toBeNull();
        // the author's open views learn the row went
        expect(told.map((event) => event.data)).toMatchObject([
          { userId: chat.memberId, sessionId, rows: [] },
        ]);
        expect(
          logs.events.findLast((event) => event.msg === "sweep")?.fields,
        ).toMatchObject({ not_sent: 1 });
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("the load answers the queue's counts and oldest wait", async () => {
    const { chat, sessionId, script } = await setup();
    try {
      const empty = await (
        await chat.admin.call("GET", "/api/admin/load")
      ).json();
      expect(empty).toMatchObject({
        queued: 0,
        notSent: 0,
        oldestQueuedAt: null,
      });
      const first = await queue(chat.member, sessionId, "one");
      chat.app.now.value += 1000;
      const second = await queue(chat.member, sessionId, "two");
      notSend(chat, second);
      const load = await (
        await chat.admin.call("GET", "/api/admin/load")
      ).json();
      expect(load).toMatchObject({
        queued: 1,
        notSent: 1,
        oldestQueuedAt: first.queuedAt,
      });
      await chat.member.call(
        "DELETE",
        `/api/sessions/${sessionId}/queued/${first.id}`,
        { body: { revision: 0 } },
      );
      script.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("Discard all's ids", () => {
  test("names one to MAX_DISCARD_IDS ids", () => {
    const id = "aaaaaaaaaaaa";
    expect(parseDiscardNotSent({ ids: [id, id] })).toEqual({ ids: [id] });
    const full = Array.from({ length: MAX_DISCARD_IDS }, (_, i) =>
      i.toString(36).padStart(12, "a"),
    );
    expect(parseDiscardNotSent({ ids: full }).ids).toHaveLength(
      MAX_DISCARD_IDS,
    );
    for (const body of [
      { ids: [] },
      { ids: [...full, "bbbbbbbbbbbb"] },
      { ids: id },
      { ids: ["not an id"] },
      { ids: [id], more: true },
      {},
    ]) {
      expect(() => parseDiscardNotSent(body)).toThrow();
    }
  });
});
