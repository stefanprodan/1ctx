// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { newId } from "../../../src/server/lib/ids.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { Registry } from "../../../src/server/runner/index.ts";
import { startSend } from "../../../src/server/runner/start.ts";
import { MAX_REGENERATE_BODY } from "../../../src/server/sessions/index.ts";
import { WEB_OFF_LINE } from "../../../src/shared/capabilities.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { collectLogs } from "../../helpers/app.ts";
import { createAutomation, startRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  NO_TOOLS,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";

async function settled(chat: ChatApp, id: string) {
  for (let i = 0; i < 200; i++) {
    if (chat.app.sessions.byId(id)?.status !== "running") return;
    await tick();
  }
  throw new Error("send did not settle");
}

async function create(
  chat: ChatApp,
  capabilities?: { disable?: string[]; enable?: string[] },
) {
  const response = await chat.member.call("POST", "/api/sessions", {
    body: {
      projectId: chat.projectId,
      agentId: chat.agentId,
      message: "hello",
      capabilities,
    },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as SessionDetail;
}

describe("a send's disabled capabilities", () => {
  test("a run snapshots the automation set and a fork keeps the run's copy", async () => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat, {
        disabledCapabilities: ["web"],
      });
      const run = await startRun(chat, automation.id);
      const policy = chat.app.runner.registry.get(run.sessionId)!.policy;
      expect(policy.disabledCapabilities).toEqual(["web"]);
      expect(policy.web).toBeNull();
      expect(
        policy.offered.tools.some((tool) => tool.name === "webfetch"),
      ).toBe(false);
      expect(JSON.stringify(run.main.body.messages)).toContain(WEB_OFF_LINE);
      expect(chat.app.sessions.byId(run.sessionId)).toMatchObject({
        origin: "automation",
        disabledCapabilities: ["web"],
      });
      const changed = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        { body: { disabledCapabilities: [] } },
      );
      expect(changed.status).toBe(200);
      expect(policy.disabledCapabilities).toEqual(["web"]);
      run.main.reply("done");
      await settled(chat, run.sessionId);
      const reply = chat.app.sessions
        .messages(run.sessionId)
        .findLast((message) => message.kind === "reply")!;
      const fork = await chat.member.call(
        "POST",
        `/api/sessions/${run.sessionId}/fork`,
        { body: { messageId: reply.id, agentId: chat.agentId } },
      );
      expect(fork.status).toBe(201);
      expect((await fork.json()).session).toMatchObject({
        origin: "chat",
        disabledCapabilities: ["web"],
      });
      const next = await startRun(chat, automation.id);
      expect(
        chat.app.runner.registry.get(next.sessionId)!.policy
          .disabledCapabilities,
      ).toEqual([]);
      expect(
        chat.app.sessions.byId(next.sessionId)!.disabledCapabilities,
      ).toEqual([]);
      next.main.reply("done");
      await settled(chat, next.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "commits the change and message in one start envelope",
    async () => {
      const chat = await chatApp();
      const events: Extract<BusEvent, { type: "session.changed" }>[] = [];
      const unsubscribe = subscribe((event) => {
        if (
          event.type === "session.changed" &&
          event.data.session.projectId === chat.projectId
        ) {
          events.push(event);
        }
      }, silent);
      try {
        const detail = await create(chat, { disable: ["web"] });
        const script = await waitScript(chat.scripted, 1);
        expect(detail.session.disabledCapabilities).toEqual(["web"]);
        expect(detail.session.revision).toBe(1);
        expect(events).toHaveLength(1);
        expect(events[0]!.data.session).toEqual(detail.session);
        expect(events[0]!.data.messages.map((row) => row.kind)).toEqual([
          "user",
          "reply",
        ]);
        const active = chat.app.runner.registry.get(detail.session.id)!;
        expect(active.policy.disabledCapabilities).toEqual(["web"]);
        expect(active.policy.web).toBeNull();
        const names = active.policy.offered.tools.map((tool) => tool.name);
        expect(names).not.toContain("webfetch");
        expect(names).not.toContain("websearch");
        expect(names).toContain("visualize");
        expect(JSON.stringify(script.body.messages)).toContain(WEB_OFF_LINE);
        script.reply("done");
        await settled(chat, detail.session.id);
      } finally {
        unsubscribe();
        await chat.app.shutdown();
      }
    },
  );

  test("an omitted change keeps the set and regenerate honours an enable", async () => {
    const chat = await chatApp();
    try {
      const first = await create(chat, { disable: ["web"] });
      (await waitScript(chat.scripted, 1)).reply("first");
      await settled(chat, first.session.id);
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${first.session.id}/messages`,
        { body: { message: "again" } },
      );
      expect(response.status).toBe(201);
      expect((await response.json()).session.disabledCapabilities).toEqual([
        "web",
      ]);
      const second = await waitScript(chat.scripted, 2);
      expect(JSON.stringify(second.body.messages)).toContain(WEB_OFF_LINE);
      second.reply("second");
      await settled(chat, first.session.id);
      const before = chat.app.sessions.byId(first.session.id)!;
      const regenerated = await chat.member.call(
        "POST",
        `/api/sessions/${first.session.id}/regenerate`,
        { body: { capabilities: { enable: ["web"] } } },
      );
      expect(regenerated.status).toBe(201);
      expect((await regenerated.json()).session).toMatchObject({
        disabledCapabilities: [],
        revision: before.revision + 1,
      });
      const third = await waitScript(chat.scripted, 3);
      expect(JSON.stringify(third.body.messages)).not.toContain(WEB_OFF_LINE);
      expect(
        chat.app.runner.registry
          .get(first.session.id)!
          .policy.offered.tools.map((tool) => tool.name),
      ).toContain("webfetch");
      third.reply("replacement");
      await settled(chat, first.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a later provider failure keeps the committed choice", async () => {
    const chat = await chatApp();
    try {
      chat.scripted.refuse(503, "provider unavailable");
      const detail = await create(chat, { disable: ["web"] });
      await settled(chat, detail.session.id);
      expect(chat.app.sessions.byId(detail.session.id)).toMatchObject({
        status: "failed",
        disabledCapabilities: ["web"],
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a running send keeps its domains and the next send reads the new mode", async () => {
    const chat = await chatApp();
    try {
      expect(
        (
          await chat.admin.call("PATCH", "/api/tools/web", {
            body: { mode: "listed", domains: ["docs.test"] },
          })
        ).status,
      ).toBe(200);
      const started = await startChat(chat);
      const policy = chat.app.runner.registry.get(started.sessionId)!.policy;
      const schemas = JSON.stringify(policy.offered.tools);
      expect(policy.web).toEqual({ mode: "listed", domains: ["docs.test"] });
      expect(policy.offered.web).toEqual(policy.web);
      expect(
        (
          await chat.admin.call("PATCH", "/api/tools/web", {
            body: { mode: "off", domains: ["other.test"] },
          })
        ).status,
      ).toBe(200);
      expect(policy.web).toEqual({ mode: "listed", domains: ["docs.test"] });
      expect(JSON.stringify(policy.offered.tools)).toBe(schemas);
      started.script.reply("done");
      await settled(chat, started.sessionId);
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${started.sessionId}/messages`,
        { body: { message: "again" } },
      );
      expect(response.status).toBe(201);
      const next = await waitScript(chat.scripted, 2);
      expect(
        chat.app.runner.registry.get(started.sessionId)!.policy.web,
      ).toBeNull();
      next.reply("done");
      await settled(chat, started.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("compact keeps the stored set without offering web or adding the line", async () => {
    const chat = await chatApp();
    try {
      const detail = await create(chat, { disable: ["web"] });
      (await waitScript(chat.scripted, 1)).reply("first answer");
      await settled(chat, detail.session.id);
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${detail.session.id}/compact`,
      );
      expect(response.status).toBe(200);
      const compact = await waitScript(chat.scripted, 2);
      expect(compact.body.tools).toBeUndefined();
      expect(JSON.stringify(compact.body.messages)).not.toContain(WEB_OFF_LINE);
      expect(
        chat.app.sessions.byId(detail.session.id)!.disabledCapabilities,
      ).toEqual(["web"]);
      compact.reply("a summary");
      await settled(chat, detail.session.id);
      expect(
        chat.app.sessions.byId(detail.session.id)!.disabledCapabilities,
      ).toEqual(["web"]);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("400, 409 and admission limits write no capability changes", async () => {
    const chat = await chatApp({
      registry: new Registry({ running: 1, perUser: 1 }),
    });
    try {
      const started = await startChat(chat);
      const before = chat.app.sessions.byId(started.sessionId);
      for (const action of ["messages", "regenerate"]) {
        const refused = await chat.member.call(
          "POST",
          `/api/sessions/${started.sessionId}/${action}`,
          {
            body: {
              ...(action === "messages" ? { message: "wait" } : {}),
              capabilities: { disable: ["web"] },
            },
          },
        );
        expect(refused.status).toBe(409);
      }
      const invalid = await chat.member.call(
        "POST",
        `/api/sessions/${started.sessionId}/messages`,
        {
          body: {
            message: "bad",
            capabilities: { disable: ["web"], enable: ["web"] },
          },
        },
      );
      expect(invalid.status).toBe(400);
      const capped = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "other",
          capabilities: { disable: ["web"] },
        },
      });
      expect(capped.status).toBe(429);
      expect(chat.app.sessions.byId(started.sessionId)).toEqual(before);
      expect(chat.app.sessions.count(chat.projectId)).toBe(1);
      expect(chat.app.sessions.messages(started.sessionId)).toHaveLength(2);
      started.script.reply("done");
      await settled(chat, started.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a failed start rolls back the changed set as well as its rows", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    try {
      const started = await startChat(chat);
      started.script.reply("first");
      await settled(chat, started.sessionId);
      const store = chat.app.sessions;
      const before = store.byId(started.sessionId);
      const messages = store.messages(started.sessionId);
      const addReply = store.addReply.bind(store);
      store.addReply = () => {
        throw new Error("failed reply write");
      };
      try {
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${started.sessionId}/messages`,
          {
            body: { message: "again", capabilities: { disable: ["web"] } },
          },
        );
        expect(response.status).toBe(500);
        expect(
          logs.events.findLast((event) => event.level === "error"),
        ).toMatchObject({
          area: "router",
          msg: "request",
          fields: {
            route: "/api/sessions/:id/messages",
            status: 500,
            error: "failed reply write",
          },
        });
      } finally {
        store.addReply = addReply;
      }
      expect(store.byId(started.sessionId)).toEqual(before);
      expect(store.messages(started.sessionId)).toEqual(messages);
      expect(chat.app.runner.registry.size).toBe(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("start reapplies the change to the current row, not the preflight row", async () => {
    const chat = await chatApp();
    try {
      const started = await startChat(chat);
      const active = chat.app.runner.registry.get(started.sessionId)!;
      started.script.reply("first");
      await settled(chat, started.sessionId);
      const stale = chat.app.sessions.byId(started.sessionId)!;
      // A second key models a future capability changed after preflight.
      chat.app.sessions.setDisabledCapabilities(stale.id, ["skill:other"]);
      const result = startSend(
        {
          db: chat.app.db,
          clock: () => chat.app.now.value,
          sessions: chat.app.sessions,
          uploads: chat.app.knowledge,
          views: { start: () => {}, resetSeen: () => {} },
        },
        {
          sendId: newId(),
          replyId: newId(),
          userId: newId(),
          sessionId: stale.id,
          session: stale,
          title: stale.title,
          text: "again",
          policy: {
            ...active.policy,
            disabledCapabilities: ["web"],
            web: null,
          },
          capabilities: { disable: ["web"] },
          mcpDigest: null,
        },
      );
      expect(result.session.disabledCapabilities).toEqual([
        "skill:other",
        "web",
      ]);
      expect(result.session.revision).toBe(stale.revision + 1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an admin's off intersects an enable without adding the refusal line", async () => {
    const chat = await chatApp();
    try {
      expect(
        (
          await chat.admin.call("PATCH", "/api/tools/web", {
            body: { mode: "off" },
          })
        ).status,
      ).toBe(200);
      const detail = await create(chat, { enable: ["web"] });
      const script = await waitScript(chat.scripted, 1);
      const policy = chat.app.runner.registry.get(detail.session.id)!.policy;
      expect(policy.web).toBeNull();
      expect(policy.disabledCapabilities).toEqual([]);
      expect(JSON.stringify(script.body.messages)).not.toContain(WEB_OFF_LINE);
      script.reply("done");
      await settled(chat, detail.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a model without tools stores the choice without the prompt line", async () => {
    const chat = await chatApp({ model: NO_TOOLS });
    try {
      const detail = await create(chat, { disable: ["web"] });
      const script = await waitScript(chat.scripted, 1);
      expect(detail.session.disabledCapabilities).toEqual(["web"]);
      expect(script.body.tools).toBeUndefined();
      expect(JSON.stringify(script.body.messages)).not.toContain(WEB_OFF_LINE);
      script.reply("done");
      await settled(chat, detail.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("regenerate rejects malformed and oversized bodies without a write", async () => {
    const chat = await chatApp();
    try {
      const started = await startChat(chat);
      started.script.reply("done");
      await settled(chat, started.sessionId);
      const before = chat.app.sessions.byId(started.sessionId);
      for (const raw of [
        "{",
        "null",
        "[]",
        '{"message":"unexpected"}',
        '{"capabilities":{"disable":["unknown"]}}',
      ]) {
        expect(
          (
            await chat.member.call(
              "POST",
              `/api/sessions/${started.sessionId}/regenerate`,
              { raw },
            )
          ).status,
        ).toBe(400);
      }
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${started.sessionId}/regenerate`,
            { raw: " ".repeat(MAX_REGENERATE_BODY + 1) },
          )
        ).status,
      ).toBe(413);
      expect(chat.app.sessions.byId(started.sessionId)).toEqual(before);
    } finally {
      await chat.app.shutdown();
    }
  });
});
