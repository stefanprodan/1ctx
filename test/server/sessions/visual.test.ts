// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { envelope } from "../../../src/server/runner/envelope.ts";
import { parseVisualParams } from "../../../src/server/sessions/parse.ts";
import { offWire } from "../../../src/server/sessions/rows.ts";
import type { SessionResponse } from "../../../src/shared/api/sessions.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";
import type { ToolCall } from "../../../src/shared/contracts/tool.ts";
import { forkRow } from "../../fixtures/sessions/fork.ts";
import {
  malformedVisualArguments,
  visualArguments,
  visualHtml,
  visualTitle,
} from "../../fixtures/sessions/visual.ts";
import type { TestClient } from "../../helpers/app.ts";
import { settleRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";

const call: ToolCall = {
  id: "drawing",
  name: "visualize",
  arguments: visualArguments,
};

function path(
  sessionId: string,
  messageId: string,
  index: string | number = 0,
) {
  return `/api/sessions/${sessionId}/messages/${messageId}/calls/${index}/visual`;
}

async function read(client: TestClient, sessionId: string) {
  const response = await client.call("GET", `/api/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SessionResponse;
}

async function stored(
  chat: ChatApp,
  projectId = chat.projectId,
  calls: ToolCall[] = [call],
) {
  const started = await startChat(
    chat,
    "Draw a diagram",
    chat.member,
    projectId,
  );
  started.script.reply("The diagram.");
  await settleRun(chat, started.sessionId);
  const store = chat.app.sessions;
  const reply = store
    .messages(started.sessionId)
    .find((row) => row.kind === "reply")!;
  chat.app.db
    .query("update messages set tool_calls = ? where id = ?")
    .run(JSON.stringify(calls), reply.id);
  const tools = store.addToolRows(
    calls.map((entry) => ({
      sessionId: reply.sessionId,
      sendId: reply.sendId,
      round: reply.round,
      toolCallId: entry.id,
      toolName: entry.name,
      now: chat.app.now.value,
    })),
  );
  for (const tool of tools) {
    store.finishTool(tool.id, {
      content: "The visual was accepted.",
      status: "done",
      error: null,
      finishedAt: chat.app.now.value,
    });
  }
  return { sessionId: reply.sessionId, reply: store.message(reply.id)!, tools };
}

describe("visual call delivery", () => {
  test("returns only the title and original source for a successful call", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, reply } = await stored(chat);
      const response = await chat.member.call("GET", path(sessionId, reply.id));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        title: visualTitle,
        html: visualHtml,
      });
      expect(chat.app.sessions.message(reply.id)?.toolCalls).toEqual([call]);
      expect(
        (await chat.app.client().call("GET", path(sessionId, reply.id))).status,
      ).toBe(401);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.each(["drawing", ""])("pairs calls by order (%j)", async (id) => {
    const chat = await chatApp();
    try {
      const second = {
        ...call,
        id,
        arguments: '{"title":"Second","html":"<p>second</p>"}',
      };
      const { sessionId, reply, tools } = await stored(chat, chat.projectId, [
        { ...call, id },
        second,
      ]);
      chat.app.db
        .query(
          "update messages set status = 'failed', error = 'refused' where id = ?",
        )
        .run(tools[0]!.id);
      expect(
        (await chat.member.call("GET", path(sessionId, reply.id, 0))).status,
      ).toBe(404);
      const response = await chat.member.call(
        "GET",
        path(sessionId, reply.id, 1),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        title: "Second",
        html: "<p>second</p>",
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses missing, unfinished, failed and mismatched rows", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, reply, tools } = await stored(chat);
      const tool = tools[0]!;
      const other = await stored(chat);
      const user = chat.app.sessions.messages(sessionId)[0]!;
      for (const url of [
        path("000000000000", reply.id),
        path("not-an-id", reply.id),
        path(":id", ":messageId", ":index"),
        path(sessionId, "000000000000"),
        path(other.sessionId, reply.id),
        path(sessionId, other.reply.id),
        path(sessionId, user.id),
        path(sessionId, tool.id),
        path(sessionId, reply.id, 1),
        path(sessionId, reply.id, Number.MAX_SAFE_INTEGER),
      ]) {
        expect((await chat.member.call("GET", url)).status).toBe(404);
      }
      for (const [status, error] of [
        ["streaming", null],
        ["failed", null],
        ["failed", "refused"],
        ["stopped", null],
        ["done", "refused"],
      ]) {
        chat.app.db
          .query("update messages set status = ?, error = ? where id = ?")
          .run(status, error, tool.id);
        expect(
          (await chat.member.call("GET", path(sessionId, reply.id))).status,
        ).toBe(404);
      }
      chat.app.db
        .query(
          "update messages set status = 'done', error = null, round = 2 where id = ?",
        )
        .run(tool.id);
      expect(
        (await chat.member.call("GET", path(sessionId, reply.id))).status,
      ).toBe(404);
      chat.app.db
        .query("update messages set round = 1, send_id = ? where id = ?")
        .run(other.reply.sendId, tool.id);
      expect(
        (await chat.member.call("GET", path(sessionId, reply.id))).status,
      ).toBe(404);
      chat.app.db
        .query(
          "update messages set send_id = ?, tool_name = 'datetime' where id = ?",
        )
        .run(reply.sendId, tool.id);
      expect(
        (await chat.member.call("GET", path(sessionId, reply.id))).status,
      ).toBe(404);
      chat.app.db
        .query(
          "update messages set tool_name = 'visualize', tool_call_id = 'other' where id = ?",
        )
        .run(tool.id);
      expect(
        (await chat.member.call("GET", path(sessionId, reply.id))).status,
      ).toBe(404);
      chat.app.db
        .query(
          "update messages set tool_call_id = ?, session_id = ?, seq = 100 where id = ?",
        )
        .run(call.id, other.sessionId, tool.id);
      expect(
        (await chat.member.call("GET", path(sessionId, reply.id))).status,
      ).toBe(404);
      chat.app.db.query("delete from messages where id = ?").run(tool.id);
      expect(
        (await chat.member.call("GET", path(sessionId, reply.id))).status,
      ).toBe(404);
      const nonvisual = await stored(chat, chat.projectId, [
        { ...call, name: "datetime" },
      ]);
      expect(
        (
          await chat.member.call(
            "GET",
            path(nonvisual.sessionId, nonvisual.reply.id),
          )
        ).status,
      ).toBe(404);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("checks personal ownership and team visibility before delivering source", async () => {
    const chat = await chatApp();
    try {
      const personal = await stored(chat);
      const outsider = chat.app.createUser({
        username: "outsider",
        fullName: "",
        email: "outsider@example.com",
        role: "member",
        passwordHash: chat.app.users.byId(chat.memberId)!.passwordHash,
        mustChangePassword: false,
        now: chat.app.now.value,
      });
      const client = chat.app.client();
      expect((await client.login(outsider.username, "pw")).status).toBe(200);
      for (const reader of [chat.admin, client]) {
        expect(
          (
            await reader.call(
              "GET",
              path(personal.sessionId, personal.reply.id),
            )
          ).status,
        ).toBe(404);
      }
      const created = await chat.admin.call("POST", "/api/projects", {
        body: { name: "visual-team", description: "" },
      });
      expect(created.status).toBe(201);
      const { project } = await created.json();
      expect(
        (
          await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
            body: { userId: chat.memberId },
          })
        ).status,
      ).toBe(201);
      const team = await stored(chat, project.id);
      const url = path(team.sessionId, team.reply.id);
      expect((await chat.admin.call("GET", url)).status).toBe(200);
      expect((await client.call("GET", url)).status).toBe(404);
      expect(
        (
          await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
            body: { userId: outsider.id },
          })
        ).status,
      ).toBe(201);
      expect((await client.call("GET", url)).status).toBe(200);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses malformed message ids and indexes on visible sessions", async () => {
    const chat = await chatApp();
    try {
      const { sessionId, reply } = await stored(chat);
      for (const index of [
        "-1",
        "1.5",
        "1e2",
        "0x1",
        "+1",
        "01",
        "NaN",
        "Infinity",
        "9007199254740992",
        "%20",
        "0%20",
      ]) {
        const response = await chat.member.call(
          "GET",
          path(sessionId, reply.id, index),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: "index must be a non-negative integer",
        });
      }
      const invalidMessage = await chat.member.call(
        "GET",
        path(sessionId, "not-an-id"),
      );
      expect(invalidMessage.status).toBe(400);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("never delivers malformed stored visual arguments", async () => {
    const chat = await chatApp();
    try {
      const calls = malformedVisualArguments.map((fixture, index) => ({
        ...call,
        id: `bad-${index}`,
        arguments: fixture.arguments,
      }));
      const { sessionId, reply } = await stored(chat, chat.projectId, calls);
      for (let index = 0; index < calls.length; index++) {
        expect(
          (await chat.member.call("GET", path(sessionId, reply.id, index)))
            .status,
        ).toBe(404);
      }
      const detail = await read(chat.member, sessionId);
      expect(JSON.stringify(detail)).not.toContain(visualHtml);
      expect(chat.app.sessions.message(reply.id)?.toolCalls).toEqual(calls);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "strips detail and durable envelopes but keeps provider history and forks",
    async () => {
      const chat = await chatApp();
      const events: BusEvent[] = [];
      const off = subscribe((event) => events.push(event));
      try {
        const started = await startChat(chat, "Draw a diagram");
        started.script.toolRound([call]);
        started.script.end();
        const next = await waitScript(chat.scripted, 2);
        expect(JSON.stringify(next.body)).toContain(visualHtml);
        next.reply("The diagram.");
        await settleRun(chat, started.sessionId);
        const rows = chat.app.sessions.messages(started.sessionId);
        const reply = rows.find((row) => row.toolCalls?.length)!;
        const answer = rows.find((row) => row.slot === "answer")!;
        expect(reply.toolCalls).toEqual([call]);
        const detail = await read(chat.member, started.sessionId);
        const delivered = detail.messages.find((row) => row.id === reply.id)!;
        expect(JSON.parse(delivered.toolCalls![0]!.arguments)).toEqual({
          title: visualTitle,
          html: new TextEncoder().encode(visualHtml).length,
        });
        expect(JSON.stringify(detail)).not.toContain(visualHtml);
        const changes = events.filter(
          (event) =>
            event.type === "session.changed" &&
            event.data.session.id === started.sessionId,
        );
        expect(
          changes.some(
            (event) =>
              event.type === "session.changed" &&
              event.data.messages.some(
                (message) =>
                  message.id === reply.id && message.toolCalls?.length,
              ),
          ),
        ).toBeTrue();
        expect(JSON.stringify(changes)).not.toContain(visualHtml);
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${started.sessionId}/fork`,
          {
            body: { messageId: answer.id, agentId: chat.agentId },
          },
        );
        expect(response.status).toBe(201);
        const copied: SessionResponse = await response.json();
        const copiedReply = chat.app.sessions
          .messages(copied.session.id)
          .find((row) => row.toolCalls?.length)!;
        expect(copiedReply.toolCalls).toEqual([call]);
        expect(JSON.stringify(copied)).not.toContain(visualHtml);
        expect(
          (
            await chat.member.call(
              "GET",
              path(copied.session.id, copiedReply.id),
            )
          ).status,
        ).toBe(200);
      } finally {
        off();
        await chat.app.shutdown();
      }
    },
  );
});

test("visual path parameters accept only stored ids and a decimal index", () => {
  const params = {
    id: "123456789abc",
    messageId: "987654321abc",
    index: "0",
  };
  expect(parseVisualParams(params)).toEqual({ ...params, index: 0 });
  for (const invalid of [
    null,
    [],
    { ...params, id: "" },
    { ...params, id: "123456789ABC" },
    { ...params, messageId: "123456789ab" },
    { ...params, index: 0 },
    { ...params, index: undefined },
    { ...params, extra: "unexpected" },
  ]) {
    expect(() => parseVisualParams(invalid)).toThrow();
  }
});

describe("visual call envelopes", () => {
  for (const fixture of malformedVisualArguments) {
    test(`strips ${fixture.name} without changing the stored call`, () => {
      const row = forkRow({
        toolCalls: [{ ...call, arguments: fixture.arguments }],
      });

      const before = structuredClone(row);
      const wire = offWire(row);
      const argumentsText = wire.toolCalls![0]!.arguments;
      expect(argumentsText).not.toContain(visualHtml);
      expect(argumentsText.length).toBeLessThan(200);
      expect(JSON.parse(argumentsText).html).toBe(fixture.bytes);
      expect(row).toEqual(before);
    });
  }

  test("counts UTF-8 and leaves other calls and result omission unchanged", () => {
    const ordinary = {
      id: "clock",
      name: "datetime",
      arguments: '{ "timezone": "UTC" }',
    };
    const row = forkRow({ toolCalls: [call, ordinary] });
    expect(offWire(row).toolCalls).toEqual([
      {
        ...call,
        arguments: JSON.stringify({
          title: visualTitle,
          html: Buffer.byteLength(visualHtml),
        }),
      },
      ordinary,
    ]);
    expect(Buffer.byteLength(visualHtml)).toBeGreaterThan(visualHtml.length);
    const tool: Message = {
      ...row,
      kind: "tool",
      content: visualHtml,
      error: visualHtml,
    };
    expect(offWire(tool)).toMatchObject({
      content: "",
      error: null,
      resultBytes: Buffer.byteLength(visualHtml),
    });
    const change = envelope(
      { id: "session" } as Parameters<typeof envelope>[0],
      [row, tool],
      null,
    );
    expect(JSON.stringify(change)).not.toContain(visualHtml);
  });
});
