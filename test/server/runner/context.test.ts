// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rows to the wire, and the system prompt, on fixtures.

import { describe, expect, test } from "bun:test";
import { history, request } from "../../../src/server/runner/context.ts";
import type { SendPolicy } from "../../../src/server/runner/policy.ts";
import {
  ABOUT_LEAD,
  dateLine,
  systemPrompt,
} from "../../../src/server/runner/prompt.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";

const NOW = Date.UTC(2026, 8, 13, 10, 0, 0);

const policy: SendPolicy = {
  projectId: "p",
  userId: "u1",
  username: "oana",
  fullName: "Oana Pellea",
  about: "I run clusters.",
  agentId: "a",
  agentName: "coder",
  providerId: "pr",
  model: "org/model",
  contextLength: 1000,
  prompt: "You write Go.",
  thinking: true,
  tools: [],
};

const row = (
  fields: Partial<Message> & Pick<Message, "id" | "kind">,
): Message => ({
  sessionId: "s",
  seq: 1,
  userId: null,
  agentId: null,
  content: "",
  reasoning: "",
  html: "",
  status: "done",
  error: null,
  finishReason: null,
  model: null,
  ttftMs: null,
  thinkingMs: null,
  createdAt: 0,
  finishedAt: null,
  ...fields,
});

const lookups = {
  usernameOf: (id: string) => (id === "u2" ? "mihai" : null),
  reasoningDetailsOf: (id: string) =>
    id === "r2" ? [{ type: "reasoning.text", text: "t" }] : null,
};

describe("systemPrompt", () => {
  test("joins the agent's prompt, the about text and the date", () => {
    expect(systemPrompt(policy, NOW)).toBe(
      `You write Go.\n\n${ABOUT_LEAD}\nI run clusters.\n\nToday is 2026-09-13.`,
    );
  });

  test("leaves out what is empty and always has the date", () => {
    expect(systemPrompt({ prompt: "", about: " " }, NOW)).toBe(dateLine(NOW));
  });
});

describe("history", () => {
  test("names the author, sends replies with something to say, skips the rest", () => {
    const rows = [
      row({ id: "u", kind: "user", userId: "u1", content: "hi" }),
      row({ id: "r1", kind: "reply", agentId: "a", content: "hello" }),
      row({ id: "u2m", kind: "user", userId: "u2", content: "and me" }),
      row({ id: "r2", kind: "reply", agentId: "a", content: "both" }),
      row({ id: "rf", kind: "reply", status: "failed", content: "" }),
      row({
        id: "rfp",
        kind: "reply",
        status: "failed",
        content: "partial",
      }),
      row({ id: "rs", kind: "reply", status: "stopped", content: "cut" }),
      row({ id: "rx", kind: "reply", status: "streaming", content: "now" }),
      row({ id: "ux", kind: "user", userId: "gone", content: "?" }),
    ];
    expect(history(rows, policy, lookups, NOW)).toEqual([
      { role: "system", content: systemPrompt(policy, NOW) },
      { role: "user", content: "hi", name: "oana" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "and me", name: "mihai" },
      {
        role: "assistant",
        content: "both",
        reasoningDetails: [{ type: "reasoning.text", text: "t" }],
      },
      { role: "assistant", content: "partial" },
      { role: "assistant", content: "cut" },
      { role: "user", content: "?" },
    ]);
  });

  test("the request carries the model, the thinking flag and the session as the cache key", () => {
    const req = request(policy, "s1", []);
    expect(req).toEqual({
      model: "org/model",
      messages: [],
      thinking: true,
      cacheKey: "s1",
    });
  });
});
