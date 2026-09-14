// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rows to the wire, the tool round history and its repair, the
// exhausted line on a copy, and the system prompt, on fixtures.

import { describe, expect, test } from "bun:test";
import type { ChatMessageIn } from "../../../src/server/providers/index.ts";
import {
  EXHAUSTED_LINE,
  history,
  request,
  SUMMARIZE,
  SUMMARY_LEAD,
  summaryRequest,
  withExhausted,
} from "../../../src/server/runner/context.ts";
import { LOOP_LIMITS } from "../../../src/server/runner/limits.ts";
import type { Offered, SendPolicy } from "../../../src/server/runner/policy.ts";
import { dateLine, systemPrompt } from "../../../src/server/runner/prompt.ts";
import { TOOL_CAPS } from "../../../src/server/tools/index.ts";
import { compactsAt, contextReserve } from "../../../src/shared/compaction.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";

const NOW = Date.UTC(2026, 8, 13, 10, 0, 0);

const NONE: Offered = { tools: [], search: null };

const policy: SendPolicy = {
  projectId: "p",
  userId: "u1",
  username: "caelea",
  fullName: "Oana Mangiurea",
  about: "I run clusters.",
  projectName: "ops",
  projectKind: "team",
  projectDescription: "Incidents and pages.",
  agentId: "a",
  agentName: "coder",
  providerId: "pr",
  model: "org/model",
  contextLength: 1000,
  prompt: "You write Go.",
  thinking: true,
  effort: "high",
  offered: NONE,
  limits: LOOP_LIMITS,
  toolCaps: TOOL_CAPS,
};

const row = (
  fields: Partial<Message> & Pick<Message, "id" | "kind">,
): Message => ({
  sessionId: "s",
  seq: 1,
  sendId: "snd1",
  round: 1,
  slot: null,
  userId: null,
  agentId: null,
  content: "",
  reasoning: "",
  html: "",
  status: "done",
  error: null,
  finishReason: null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  model: null,
  ttftMs: null,
  thinkingMs: null,
  createdAt: 0,
  finishedAt: null,
  ...fields,
  resultBytes: fields.resultBytes ?? null,
  promptTokens: fields.promptTokens ?? null,
});

const lookups = {
  usernameOf: (id: string) => (id === "u2" ? "mihai" : null),
  reasoningDetailsOf: (id: string) =>
    id === "r2" ? [{ type: "reasoning.text", text: "t" }] : null,
};

describe("compaction threshold", () => {
  test("caps the reserve at a quarter of the context", () => {
    expect(contextReserve(40_000, 20_000)).toBe(10_000);
    expect(contextReserve(100_000, 20_000)).toBe(20_000);
  });

  test("has no threshold without a usable context window", () => {
    expect(compactsAt(null, 20_000)).toBeNull();
    expect(compactsAt(1000, 1000)).toBe(750);
    expect(compactsAt(0, 1000)).toBeNull();
  });
});

describe("systemPrompt", () => {
  test("joins the agent's prompt, the about text and the date", () => {
    expect(systemPrompt(policy, NOW)).toBe(
      "You write Go.\n\nYou work in the ops project: Incidents and pages.\nYou talk to @caelea (Oana Mangiurea): I run clusters.\n\nToday is 2026-09-13.",
    );
  });

  test("names the project and the user even with nothing written", () => {
    expect(
      systemPrompt(
        { ...policy, prompt: " ", projectDescription: "", about: " " },
        NOW,
      ),
    ).toBe(
      `You work in the ops project.\nYou talk to @caelea (Oana Mangiurea).\n\n${dateLine(NOW)}`,
    );
  });

  test("names a personal project by its owner, not by its name", () => {
    expect(
      systemPrompt(
        {
          ...policy,
          prompt: "",
          projectKind: "personal",
          projectName: "personal",
        },
        NOW,
      ),
    ).toBe(
      `You work in @caelea's personal project: Incidents and pages.\nYou talk to @caelea (Oana Mangiurea): I run clusters.\n\n${dateLine(NOW)}`,
    );
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
      { role: "user", content: "hi", name: "caelea" },
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

  test("a complete work round: the calls turn and each tool row in order", () => {
    const calls = [
      { id: "c1", name: "get_current_time", arguments: "{}" },
      { id: "c2", name: "websearch", arguments: '{"q":"x"}' },
    ];
    const rows = [
      row({ id: "u", kind: "user", userId: "u1", content: "when and what" }),
      row({
        id: "w1",
        kind: "reply",
        agentId: "a",
        content: "let me check",
        slot: "work",
        sendId: "snd1",
        round: 1,
        toolCalls: calls,
      }),
      row({
        id: "t1",
        kind: "tool",
        sendId: "snd1",
        round: 1,
        toolCallId: "c1",
        toolName: "get_current_time",
        content: "2026-09-13",
      }),
      row({
        id: "t2",
        kind: "tool",
        sendId: "snd1",
        round: 1,
        toolCallId: "c2",
        toolName: "websearch",
        content: "a result",
      }),
      row({
        id: "a1",
        kind: "reply",
        agentId: "a",
        slot: "answer",
        sendId: "snd1",
        round: 2,
        content: "the answer",
      }),
    ];
    const out = history(rows, policy, lookups, NOW);
    expect(out.slice(1)).toEqual([
      { role: "user", content: "when and what", name: "caelea" },
      {
        role: "assistant",
        content: "let me check",
        toolCalls: calls,
      },
      { role: "tool", toolCallId: "c1", content: "2026-09-13" },
      { role: "tool", toolCallId: "c2", content: "a result" },
      { role: "assistant", content: "the answer" },
    ]);
  });

  test("pairs duplicate call ids by call order", () => {
    const calls = [
      { id: "same", name: "first", arguments: "{}" },
      { id: "same", name: "second", arguments: "{}" },
    ];
    const rows = [
      row({ id: "w", kind: "reply", slot: "work", toolCalls: calls }),
      row({
        id: "t1",
        kind: "tool",
        toolCallId: "same",
        toolName: "first",
        content: "one",
      }),
      row({
        id: "t2",
        kind: "tool",
        toolCallId: "same",
        toolName: "second",
        content: "two",
      }),
    ];
    expect(history(rows, policy, lookups, NOW).slice(1)).toEqual([
      { role: "assistant", content: null, toolCalls: calls },
      { role: "tool", toolCallId: "same", content: "one" },
      { role: "tool", toolCallId: "same", content: "two" },
    ]);
  });

  test("a work reply with no text goes back with null content and its calls", () => {
    const calls = [{ id: "c1", name: "time", arguments: "{}" }];
    const rows = [
      row({
        id: "w1",
        kind: "reply",
        agentId: "a",
        content: "",
        slot: "work",
        toolCalls: calls,
      }),
      row({
        id: "t1",
        kind: "tool",
        toolCallId: "c1",
        toolName: "time",
        content: "now",
      }),
    ];
    const out = history(rows, policy, lookups, NOW);
    expect(out[1]).toEqual({
      role: "assistant",
      content: null,
      toolCalls: calls,
    });
  });

  test("an incomplete work round: no result row, sent as plain text without calls", () => {
    const calls = [
      { id: "c1", name: "time", arguments: "{}" },
      { id: "c2", name: "websearch", arguments: "{}" },
    ];
    const rows = [
      row({
        id: "w1",
        kind: "reply",
        agentId: "a",
        content: "trying",
        slot: "work",
        toolCalls: calls,
      }),
      // only one of the two calls has a result row
      row({
        id: "t1",
        kind: "tool",
        toolCallId: "c1",
        toolName: "time",
        content: "now",
      }),
    ];
    const out = history(rows, policy, lookups, NOW);
    expect(out.slice(1)).toEqual([{ role: "assistant", content: "trying" }]);
  });

  test("an incomplete work round with no text is skipped", () => {
    const calls = [{ id: "c1", name: "time", arguments: "{}" }];
    const rows = [
      row({
        id: "w1",
        kind: "reply",
        agentId: "a",
        content: "",
        slot: "work",
        toolCalls: calls,
      }),
    ];
    expect(history(rows, policy, lookups, NOW).slice(1)).toEqual([]);
  });

  test("an orphan tool row is skipped", () => {
    const rows = [
      row({ id: "u", kind: "user", userId: "u1", content: "hi" }),
      row({
        id: "t1",
        kind: "tool",
        toolCallId: "c1",
        toolName: "time",
        content: "now",
      }),
      row({ id: "r1", kind: "reply", agentId: "a", content: "hello" }),
    ];
    expect(history(rows, policy, lookups, NOW).slice(1)).toEqual([
      { role: "user", content: "hi", name: "caelea" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("history starts after the last done summary", () => {
    const rows = [
      row({ id: "u1", kind: "user", content: "old", userId: "u1" }),
      row({ id: "s1", kind: "summary", content: "first summary" }),
      row({ id: "u2", kind: "user", content: "middle", userId: "u1" }),
      row({
        id: "sf",
        kind: "summary",
        content: "failed summary",
        status: "failed",
      }),
      row({ id: "s2", kind: "summary", content: "latest summary" }),
      row({
        id: "ss",
        kind: "summary",
        content: "streaming summary",
        status: "streaming",
      }),
      row({ id: "u3", kind: "user", content: "new", userId: "u1" }),
      row({ id: "r3", kind: "reply", content: "answer", slot: "answer" }),
    ];
    expect(history(rows, policy, lookups, NOW).slice(1)).toEqual([
      { role: "user", content: `${SUMMARY_LEAD}\n\nlatest summary` },
      { role: "user", content: "new", name: "caelea" },
      { role: "assistant", content: "answer" },
    ]);
  });

  test("the summary request has no tools and uses the smaller token cap", () => {
    const withTools: SendPolicy = {
      ...policy,
      contextLength: 8000,
      limits: {
        ...policy.limits,
        contextReserve: 3000,
        summaryMaxTokens: 4096,
      },
      offered: {
        tools: [{ name: "time", description: "d", parameters: {} }],
        search: null,
      },
    };
    const req = summaryRequest(withTools, "s1", [
      { role: "system", content: "system" },
    ]);
    expect(req).toEqual({
      model: "org/model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: SUMMARIZE },
      ],
      thinking: false,
      reasoningEffort: null,
      cacheKey: "s1",
      maxTokens: 2000,
    });
    // the answer left less room than the reserve: the summary fits it
    expect(summaryRequest(withTools, "s1", [], 6500).maxTokens).toBe(1244);
    // and never asks for less than the floor
    expect(summaryRequest(withTools, "s1", [], 7900).maxTokens).toBe(128);
    // a model with no window is capped by the limit alone
    expect(
      summaryRequest({ ...withTools, contextLength: null }, "s1", [], 6500)
        .maxTokens,
    ).toBe(4096);
  });

  test("the request carries the model, the thinking flag and the session as the cache key", () => {
    const req = request(policy, "s1", []);
    expect(req).toEqual({
      model: "org/model",
      messages: [],
      thinking: true,
      reasoningEffort: "high",
      cacheKey: "s1",
    });
  });

  test("the request carries the offered tools when there are any", () => {
    const withTools: SendPolicy = {
      ...policy,
      offered: {
        tools: [{ name: "time", description: "d", parameters: {} }],
        search: null,
      },
    };
    const req = request(withTools, "s1", []);
    expect(req.tools).toEqual([
      { name: "time", description: "d", parameters: {} },
    ]);
  });
});

describe("withExhausted", () => {
  test("appends the line to a copy of the last tool message, not the original", () => {
    const messages: ChatMessageIn[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "tool", toolCallId: "c1", content: "a result" },
    ];
    const out = withExhausted(messages);
    expect(out[2]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: `a result\n\n${EXHAUSTED_LINE}`,
    });
    // the original is untouched
    expect(messages[2]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: "a result",
    });
  });

  test("with no tool message, appends a final user message", () => {
    const messages: ChatMessageIn[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const out = withExhausted(messages);
    expect(out[out.length - 1]).toEqual({
      role: "user",
      content: EXHAUSTED_LINE,
    });
    expect(messages).toHaveLength(2);
  });
});
