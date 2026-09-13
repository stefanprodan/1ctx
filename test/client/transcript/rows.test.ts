// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { groupRows, type Node } from "../../../src/client/transcript/rows.ts";
import type { Live } from "../../../src/client/transcript/stream.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";

const message = (
  id: string,
  seq: number,
  kind: "user" | "reply" | "tool",
  fields: Partial<Message> = {},
): Message => ({
  id,
  sessionId: "s1",
  seq,
  kind,
  sendId: "send1",
  round: 1,
  slot: kind === "reply" ? "answer" : null,
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  userId: kind === "user" ? "u1" : null,
  agentId: kind === "reply" ? "a1" : null,
  content: id,
  reasoning: "",
  html: kind === "reply" ? `<p>${id}</p>` : "",
  status: "done",
  error: null,
  finishReason: null,
  model: kind === "reply" ? "model" : null,
  ttftMs: null,
  thinkingMs: null,
  createdAt: seq,
  finishedAt: seq,
  ...fields,
});

const live = (reasoning: string): Live => ({
  content: "",
  reasoning,
  html: "",
  htmlAt: 0,
  thinkStart: null,
  thinkEnd: null,
  thinkMs: null,
});

const reply = (node: Node): Extract<Node, { kind: "reply" }> => {
  if (node.kind !== "reply") throw new Error("expected reply");
  return node;
};

describe("transcript rows", () => {
  test("orders messages by sequence without changing the input", () => {
    const messages = [
      message("r2", 4, "reply", { sendId: "send2" }),
      message("u1", 1, "user"),
      message("r1", 2, "reply"),
      message("u2", 3, "user", { sendId: "send2" }),
    ];
    const rows = groupRows(messages, new Map());
    expect(rows.map((node) => node.message.id)).toEqual([
      "u1",
      "r1",
      "u2",
      "r2",
    ]);
    expect(messages.map((item) => item.id)).toEqual(["r2", "u1", "r1", "u2"]);
  });

  test("marks reasoning from either the row or its live buffer", () => {
    const rows = groupRows(
      [
        message("r1", 1, "reply", { reasoning: "stored" }),
        message("r2", 2, "reply", {
          sendId: "send2",
          slot: null,
          status: "streaming",
        }),
        message("r3", 3, "reply", { sendId: "send3" }),
      ],
      new Map([
        ["r2", live("streaming")],
        ["r3", live("")],
      ]),
    );
    expect(rows.map((node) => reply(node).think)).toEqual([true, true, false]);
    expect(reply(rows[1]).live?.reasoning).toBe("streaming");
  });

  test("keeps the answer and drops work and tool rows", () => {
    const messages = [
      message("u1", 1, "user"),
      // a work reply that asked for a tool: dropped from the nodes
      message("w1", 2, "reply", { slot: "work", toolCalls: [] }),
      // the tool row that answered: dropped
      message("t1", 3, "tool", {
        slot: null,
        toolCallId: "c1",
        toolName: "get_current_time",
      }),
      // the send's answer: shown
      message("a1", 4, "reply", { slot: "answer" }),
    ];
    const rows = groupRows(messages, new Map());
    expect(rows.map((node) => node.message.id)).toEqual(["u1", "a1"]);
  });

  test("shows a streaming reply that has no slot yet", () => {
    const rows = groupRows(
      [
        message("u1", 1, "user"),
        message("r1", 2, "reply", { slot: null, status: "streaming" }),
      ],
      new Map(),
    );
    expect(rows.map((node) => node.message.id)).toEqual(["u1", "r1"]);
  });

  test("drops a streaming work reply from the nodes", () => {
    const rows = groupRows(
      [
        message("u1", 1, "user"),
        message("w1", 2, "reply", { slot: "work", status: "streaming" }),
      ],
      new Map([["w1", live("still thinking")]]),
    );
    expect(rows.map((node) => node.message.id)).toEqual(["u1"]);
  });
});
