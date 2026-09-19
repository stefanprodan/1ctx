// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The send transactions: each writes one coherent durable change,
// bumps the revision once and publishes one envelope after commit. A
// failure injected into every tool-loop transaction rolls it all back;
// checkpoints remain outside revisions.

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../src/server/lib/bus.ts";
import { FINALIZE_RETRY_MS } from "../../src/server/runner/index.ts";
import type { Tools } from "../../src/server/tools/index.ts";
import { chatApp, startChat, tick } from "../helpers/chat.ts";

function envelopes() {
  const seen: Extract<BusEvent, { type: "session.changed" }>["data"][] = [];
  const stop = subscribe((e) => {
    if (e.type === "session.changed") seen.push(e.data);
  });
  return { seen, stop };
}

describe("startSend", () => {
  test.serial(
    "writes the session, the user message, the reply, the send and the state in one revision",
    async () => {
      const chat = await chatApp();
      const { seen, stop } = envelopes();
      try {
        const { detail, sessionId } = await startChat(
          chat,
          "Hello there\nmore",
        );
        expect(detail.session).toMatchObject({
          projectId: chat.projectId,
          ownerId: chat.memberId,
          agentId: chat.agentId,
          title: "Hello there",
          status: "running",
          revision: 1,
        });
        expect(detail.messages.map((m: { kind: string }) => m.kind)).toEqual([
          "user",
          "reply",
        ]);
        expect(detail.messages[0]).toMatchObject({
          userId: chat.memberId,
          content: "Hello there\nmore",
          status: "done",
          seq: 1,
        });
        expect(detail.messages[1]).toMatchObject({
          agentId: chat.agentId,
          status: "streaming",
          seq: 2,
        });
        expect(detail.send).toMatchObject({
          sessionId,
          status: "running",
          firstMessageId: detail.messages[0].id,
          userId: chat.memberId,
        });
        expect(detail.live).toMatchObject({
          sendId: detail.send.id,
          messageId: detail.messages[1].id,
          seq: 0,
        });
        expect(seen).toHaveLength(1);
        expect(seen[0].session.revision).toBe(1);
        expect(seen[0].messages).toHaveLength(2);
        expect(seen[0].send?.id).toBe(detail.send.id);
        expect(seen[0].last).toEqual({
          seq: 1,
          author: "caelea",
          text: "Hello there",
        });
      } finally {
        stop();
      }
    },
  );

  test.serial("a write that fails leaves no row and no lock", async () => {
    const chat = await chatApp();
    const { seen, stop } = envelopes();
    try {
      const store = chat.app.sessions;
      const original = store.createSend.bind(store);
      store.createSend = () => {
        throw new Error("disk full");
      };
      try {
        // a store failure is a bug, and the router lets it propagate
        await expect(
          chat.member.call("POST", "/api/sessions", {
            body: {
              projectId: chat.projectId,
              agentId: chat.agentId,
              message: "x",
            },
          }),
        ).rejects.toThrow("disk full");
      } finally {
        store.createSend = original;
      }
      expect(seen).toEqual([]);
      expect(store.list([chat.projectId], "")).toEqual([]);
      expect(chat.app.runner.registry.size).toBe(0);
      // and the next send is admitted
      const again = await startChat(chat);
      expect(again.detail.session.status).toBe("running");
    } finally {
      stop();
    }
  });
});

describe("the checkpoint", () => {
  test("writes the partial reply without touching the revision", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat);
    const replyId = detail.messages[1].id;
    script.content("a".repeat(3000));
    await tick();
    const row = chat.app.sessions.message(replyId)!;
    expect(row.status).toBe("streaming");
    expect(row.content).toBe("a".repeat(3000));
    expect(chat.app.sessions.byId(sessionId)!.revision).toBe(1);
    // the detail carries the live tail with what the checkpoint may lag
    script.content("b");
    await tick();
    const res = await chat.member.call("GET", `/api/sessions/${sessionId}`);
    const body = await res.json();
    expect(body.live.content).toBe(`${"a".repeat(3000)}b`);
    expect(body.session.revision).toBe(1);
    script.reply(" done");
  });
});

describe("finalizeSend", () => {
  test.serial(
    "writes the reply's end, the usage and the send's end in one revision",
    async () => {
      const chat = await chatApp();
      const { seen, stop } = envelopes();
      try {
        const { detail, script, sessionId } = await startChat(chat);
        script.reasoning("thinking");
        script.content("Hi **there**");
        script.finish();
        script.usage({ prompt: 12, completion: 7 });
        script.end();
        await tick();
        await tick();
        const session = chat.app.sessions.byId(sessionId)!;
        expect(session.status).toBe("done");
        expect(session.revision).toBe(2);
        const reply = chat.app.sessions.message(detail.messages[1].id)!;
        expect(reply).toMatchObject({
          status: "done",
          content: "Hi **there**",
          reasoning: "thinking",
          finishReason: "stop",
          error: null,
        });
        expect(reply.html).toContain("<strong");
        expect(reply.finishedAt).not.toBeNull();
        const send = chat.app.sessions.send(detail.send.id)!;
        expect(send).toMatchObject({
          status: "done",
          cause: "finish",
          error: null,
        });
        // the round's usage rides on the session summary, so the envelope
        // carries the numbers with the reply
        expect(session.usage).toMatchObject({
          promptTokens: 12,
          completionTokens: 7,
          contextLength: 1048576,
        });
        expect(detail.session.usage).toBeNull();
        expect(chat.app.usage.forSession(sessionId)).toMatchObject([
          {
            sendId: detail.send.id,
            promptTokens: 12,
            completionTokens: 7,
            round: 1,
          },
        ]);
        expect(seen).toHaveLength(2);
        expect(seen[1].session.revision).toBe(2);
        expect(seen[1].messages.map((m) => m.id)).toEqual([reply.id]);
        expect(seen[1].send?.status).toBe("done");
        expect(seen[1].session.usage?.promptTokens).toBe(12);
        expect(seen[1].last).toEqual({
          seq: reply.seq,
          author: "coder",
          text: "Hi there",
        });
        expect(chat.app.runner.registry.size).toBe(0);
      } finally {
        stop();
      }
    },
  );

  test("the rows agree with the lock after a finish, so a second send goes", async () => {
    const chat = await chatApp();
    const { script, sessionId } = await startChat(chat);
    script.reply("one");
    await tick();
    await tick();
    const pending = chat.scripted.next();
    const res = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      {
        body: { message: "again" },
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.messages).toHaveLength(4);
    expect(body.session.revision).toBe(3);
    const second = await pending;
    // the history the model sees: the prompt, then the turns so far
    const roles = (second.body.messages as { role: string }[]).map(
      (m) => m.role,
    );
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    second.reply("two");
  });

  test.serial("omits the last line when a reply is stopped", async () => {
    const chat = await chatApp();
    const { seen, stop } = envelopes();
    try {
      const { script, sessionId } = await startChat(chat, "stop this");
      script.content("partial answer");
      await tick();
      await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
      await tick();
      await tick();
      const ended = seen.find((event) => event.send?.cause === "stop");
      expect(ended).toBeDefined();
      expect(ended!.last).toBeUndefined();
    } finally {
      stop();
      chat.app.socket.dispose();
    }
  });
});

describe("markRoundWork", () => {
  test.serial(
    "the first tool call delta moves the reply into the fold in one revision",
    async () => {
      const chat = await chatApp();
      const { seen, stop } = envelopes();
      try {
        const { detail, script, sessionId } = await startChat(chat, "when");
        // the first call delta marks the reply work, guarded by its null
        // slot, in its own transaction: one revision, one envelope
        script.toolCall({
          id: "c1",
          name: "datetime",
          arguments: '{"timezone":"UTC"}',
        });
        await tick();
        const reply = chat.app.sessions.message(detail.messages[1].id)!;
        expect(reply.slot).toBe("work");
        expect(chat.app.sessions.byId(sessionId)!.revision).toBe(2);
        const work = seen.find((e) => e.session.revision === 2);
        expect(work).toBeDefined();
        expect(work!.messages.map((m) => m.id)).toEqual([
          detail.messages[1].id,
        ]);
        expect(work!.messages[0]!.slot).toBe("work");
        // stop the send so the test does not leave a stream open
        await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
        await tick();
        await tick();
      } finally {
        stop();
      }
      chat.app.socket.dispose();
    },
  );
});

describe("finishTool rollback", () => {
  test.serial(
    "a failed finish keeps every tool tracked and aborts its siblings",
    async () => {
      let release:
        | ((value: { content: string; error: boolean }) => void)
        | null = null;
      let siblingAborted = false;
      const tools: Tools = {
        capabilities: () => [],
        offered: () => ({
          search: null,
          skills: { block: "", skills: [] },
          mcp: [],
          mcpPrompt: { text: "", digest: {} },
          mcpCatalog: "",
          memory: null,
          web: null,
          tools: [
            {
              name: "datetime",
              description: "time",
              parameters: { type: "object" },
            },
          ],
        }),
        run: async (_offered, call, ctx) => {
          if (call.id === "first") {
            return new Promise((resolve) => {
              release = resolve;
            });
          }
          return new Promise((resolve) => {
            const timer = setTimeout(
              () => resolve({ content: "did not abort", error: false }),
              1000,
            );
            ctx.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                siblingAborted = true;
                resolve({ content: "aborted", error: true });
              },
              { once: true },
            );
          });
        },
      };
      const chat = await chatApp({ tools });
      const { seen, stop } = envelopes();
      try {
        const { detail, script, sessionId } = await startChat(
          chat,
          "two tools",
        );
        script.toolRound([
          {
            id: "first",
            name: "datetime",
            arguments: '{"timezone":"UTC"}',
          },
          {
            id: "second",
            name: "datetime",
            arguments: '{"timezone":"Asia/Tokyo"}',
          },
        ]);
        script.end();
        for (let i = 0; i < 50 && release === null; i++) await tick();
        expect(release).not.toBeNull();
        expect(
          chat.app.sessions
            .messages(sessionId)
            .filter((row) => row.kind === "tool" && row.status === "streaming"),
        ).toHaveLength(2);

        const store = chat.app.sessions;
        const original = store.touch.bind(store);
        store.touch = (id, fields) => {
          original(id, fields);
          store.touch = original;
          throw new Error("touch failed after the tool update");
        };
        release!({ content: "first result", error: false });

        for (let i = 0; i < 50; i++) {
          if (chat.app.runner.registry.get(sessionId) === null) break;
          await tick();
        }
        const rows = chat.app.sessions
          .messages(sessionId)
          .filter((row) => row.kind === "tool");
        expect(siblingAborted).toBe(true);
        expect(rows.map((row) => row.status)).toEqual(["stopped", "stopped"]);
        expect(rows.map((row) => row.content)).toEqual([
          "stopped before it finished",
          "stopped before it finished",
        ]);
        expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
          status: "failed",
          cause: "failure",
          error: "touch failed after the tool update",
        });
        expect(
          seen.filter(
            (event) =>
              event.send?.id === detail.send.id &&
              event.send?.status === "failed",
          ),
        ).toHaveLength(1);
        expect(chat.app.runner.registry.get(sessionId)).toBeNull();
      } finally {
        stop();
        chat.app.socket.dispose();
      }
    },
  );
});

describe("finalizeSend rollback", () => {
  test("a retry still stops tool rows rolled back by the first attempt", async () => {
    const tools: Tools = {
      capabilities: () => [],
      offered: () => ({
        search: null,
        skills: { block: "", skills: [] },
        mcp: [],
        mcpPrompt: { text: "", digest: {} },
        mcpCatalog: "",
        memory: null,
        web: null,
        tools: [
          {
            name: "datetime",
            description: "time",
            parameters: { type: "object" },
          },
        ],
      }),
      run: async (_offered, _call, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => resolve({ content: "aborted", error: true }),
            { once: true },
          );
        }),
    };
    const chat = await chatApp({ tools });
    const { detail, script, sessionId } = await startChat(chat, "stop tool");
    script.toolRound([
      {
        id: "call",
        name: "datetime",
        arguments: '{"timezone":"UTC"}',
      },
    ]);
    script.end();
    for (let i = 0; i < 50; i++) {
      const tool = chat.app.sessions
        .messages(sessionId)
        .find((row) => row.kind === "tool");
      if (tool?.status === "streaming") break;
      await tick();
    }

    const store = chat.app.sessions;
    const original = store.finishSend.bind(store);
    let attempts = 0;
    store.finishSend = (id, fields) => {
      attempts++;
      if (attempts === 1) throw new Error("first finalize failed");
      return original(id, fields);
    };
    await chat.member.call("POST", `/api/sessions/${sessionId}/stop`);
    await tick();
    chat.app.now.value += FINALIZE_RETRY_MS;
    await tick();
    await tick();
    store.finishSend = original;

    expect(attempts).toBe(2);
    expect(
      chat.app.sessions.messages(sessionId).find((row) => row.kind === "tool"),
    ).toMatchObject({
      status: "stopped",
      content: "stopped before it finished",
    });
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "stopped",
      cause: "stop",
    });
    expect(chat.app.runner.registry.get(sessionId)).toBeNull();
    chat.app.socket.dispose();
  });
});

describe("new tool transaction rollback", () => {
  test("markRoundWork rolls back its slot and revision before failure ends the send", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "mark");
    const store = chat.app.sessions;
    const original = store.markRoundWork.bind(store);
    store.markRoundWork = (id) => {
      original(id);
      store.markRoundWork = original;
      throw new Error("mark failed");
    };

    script.toolCall({
      id: "call",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    for (let i = 0; i < 20; i++) await tick();

    expect(chat.app.sessions.byId(sessionId)?.revision).toBe(2);
    expect(chat.app.sessions.message(detail.messages[1].id)).toMatchObject({
      status: "failed",
      slot: "work",
      error: "mark failed",
    });
    expect(chat.app.sessions.messages(sessionId)).toHaveLength(2);
    chat.app.socket.dispose();
  });

  test("finishRound rolls back its reply, usage and tool rows", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "finish round");
    script.toolCall({
      id: "call",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    await tick();
    const store = chat.app.sessions;
    const original = store.addToolRows.bind(store);
    store.addToolRows = (calls) => {
      original(calls);
      store.addToolRows = original;
      throw new Error("tool rows failed");
    };

    script.finish("tool_calls");
    script.usage({ prompt: 12, completion: 3 });
    script.end();
    for (let i = 0; i < 20; i++) await tick();

    const rows = chat.app.sessions.messages(sessionId);
    expect(rows.filter((row) => row.kind === "tool")).toEqual([]);
    expect(rows[1]).toMatchObject({
      status: "failed",
      slot: "work",
      error: "tool rows failed",
    });
    expect(chat.app.sessions.byId(sessionId)?.revision).toBe(3);
    expect(chat.app.usage.forSession(sessionId)).toHaveLength(1);
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "failed",
      rounds: 1,
      toolCalls: 0,
    });
    chat.app.socket.dispose();
  });

  test("startRound rolls back the new reply and round counter", async () => {
    const chat = await chatApp();
    const { detail, script, sessionId } = await startChat(chat, "next round");
    script.toolCall({
      id: "call",
      name: "datetime",
      arguments: '{"timezone":"UTC"}',
    });
    await tick();
    const store = chat.app.sessions;
    const original = store.addReply.bind(store);
    store.addReply = (fields) => {
      if (fields.round !== 2) return original(fields);
      original(fields);
      store.addReply = original;
      throw new Error("next reply failed");
    };

    script.finish("tool_calls");
    script.usage();
    script.end();
    for (let i = 0; i < 30; i++) await tick();

    const replies = chat.app.sessions
      .messages(sessionId)
      .filter((row) => row.kind === "reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ status: "done", slot: "work" });
    expect(chat.app.sessions.send(detail.send.id)).toMatchObject({
      status: "failed",
      error: "next reply failed",
      rounds: 1,
      toolCalls: 1,
    });
    expect(chat.app.sessions.byId(sessionId)?.revision).toBe(5);
    chat.app.socket.dispose();
  });
});
