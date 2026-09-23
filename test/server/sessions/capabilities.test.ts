// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { BadRequest } from "../../../src/server/lib/errors.ts";
import {
  MAX_REGENERATE_BODY,
  MAX_SESSION_BODY,
  parseCreateSession,
  parseRegenerate,
  parseSendMessage,
} from "../../../src/server/sessions/index.ts";
import {
  MAX_CAPABILITY_KEY,
  MAX_DISABLED_CAPABILITIES,
} from "../../../src/shared/capabilities.ts";
import { MAX_MESSAGE_BYTES } from "../../../src/shared/words.ts";
import { settleRun } from "../../helpers/automations.ts";
import { chatApp, startChat } from "../../helpers/chat.ts";

const parsers = [
  {
    name: "create",
    parse: (capabilities: unknown) =>
      parseCreateSession({
        projectId: "project",
        agentId: "agent",
        message: "hello",
        capabilities,
      }),
  },
  {
    name: "send",
    parse: (capabilities: unknown) =>
      parseSendMessage({ message: "hello", capabilities }),
  },
  {
    name: "regenerate",
    parse: (capabilities: unknown) => parseRegenerate({ capabilities }),
  },
];

describe("session capability parsing", () => {
  for (const { name, parse } of parsers) {
    test(`${name} accepts and deduplicates a change`, () => {
      expect(parse({ disable: ["web", "web"] }).capabilities).toEqual({
        disable: ["web"],
      });
      expect(parse({ enable: ["web"] }).capabilities).toEqual({
        enable: ["web"],
      });
      expect(parse({}).capabilities).toEqual({});
    });

    test(`${name} refuses malformed or unbounded changes`, () => {
      for (const capabilities of [
        null,
        undefined,
        [],
        "web",
        { web: false },
        { disable: "web" },
        { disable: [null] },
        { disable: ["unknown"] },
        { disable: ["web:name"] },
        { disable: ["w".repeat(MAX_CAPABILITY_KEY + 1)] },
        { disable: ["web"], enable: ["web"] },
        { enable: Array(MAX_DISABLED_CAPABILITIES + 1).fill("web") },
      ]) {
        expect(() => parse(capabilities)).toThrow(BadRequest);
        expect(() => parse(capabilities)).toThrow("capabilities");
      }
    });
  }

  test("absence keeps the change absent and regenerate accepts only changes", () => {
    expect(parseSendMessage({ message: "hello" })).toEqual({
      message: "hello",
    });
    expect(
      parseCreateSession({
        projectId: "project",
        agentId: "agent",
        message: "hello",
      }),
    ).not.toHaveProperty("capabilities");
    expect(parseRegenerate({})).toEqual({});
    expect(() => parseRegenerate({ message: "hello" })).toThrow(BadRequest);
    expect(() =>
      parseSendMessage({ message: "hello", disabledCapabilities: ["web"] }),
    ).toThrow(BadRequest);
  });

  test("body budgets hold the full bounded change beside a maximum message", () => {
    const capabilities = {
      disable: Array(MAX_DISABLED_CAPABILITIES).fill(
        "w".repeat(MAX_CAPABILITY_KEY),
      ),
    };
    expect(Buffer.byteLength(JSON.stringify({ capabilities }))).toBeLessThan(
      MAX_REGENERATE_BODY,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({
          projectId: "p".repeat(12),
          agentId: "a".repeat(12),
          message: "m".repeat(MAX_MESSAGE_BYTES),
          capabilities,
          uploads: Array.from({ length: 10 }, (_, i) => `upload-${i}`),
        }),
      ),
    ).toBeLessThan(MAX_SESSION_BODY);
  });
});

test("the capability setter shares the caller's transaction and revision", async () => {
  const chat = await chatApp();
  try {
    const { sessionId } = await startChat(chat);
    const initial = chat.app.sessions.byId(sessionId)!;
    expect(initial.disabledCapabilities).toEqual([]);
    expect(() =>
      transact(chat.app.db, () => {
        chat.app.sessions.setDisabledCapabilities(sessionId, ["web"]);
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    expect(chat.app.sessions.byId(sessionId)).toEqual(initial);
    transact(chat.app.db, () => {
      chat.app.sessions.setDisabledCapabilities(sessionId, ["web"]);
      return { result: undefined };
    });
    expect(chat.app.sessions.byId(sessionId)).toEqual({
      ...initial,
      disabledCapabilities: ["web"],
    });
    expect(
      chat.app.sessions.list([chat.projectId], "").rows[0]?.session
        .disabledCapabilities,
    ).toEqual(["web"]);
  } finally {
    await chat.app.shutdown();
  }
});

test("a fork at an earlier turn copies the source's current capability set", async () => {
  const chat = await chatApp();
  try {
    const { sessionId, script } = await startChat(chat);
    script.reply("first answer");
    await settleRun(chat, sessionId);
    const reply = chat.app.sessions
      .messages(sessionId)
      .find((row) => row.kind === "reply")!;
    chat.app.sessions.setDisabledCapabilities(sessionId, ["web"]);
    const response = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/fork`,
      { body: { messageId: reply.id, agentId: chat.agentId } },
    );
    expect(response.status).toBe(201);
    const { session } = await response.json();
    expect(session.disabledCapabilities).toEqual(["web"]);
    chat.app.sessions.setDisabledCapabilities(sessionId, []);
    expect(chat.app.sessions.byId(session.id)?.disabledCapabilities).toEqual([
      "web",
    ]);
  } finally {
    await chat.app.shutdown();
  }
});
