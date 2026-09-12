// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { groupRows, type Node } from "../../../src/client/transcript/rows.ts";
import type { Live } from "../../../src/client/transcript/stream.ts";
import type { Message } from "../../../src/shared/contracts/session.ts";

const message = (
  id: string,
  seq: number,
  kind: "user" | "reply",
  reasoning = "",
): Message => ({
  id,
  sessionId: "s1",
  seq,
  kind,
  userId: kind === "user" ? "u1" : null,
  agentId: kind === "reply" ? "a1" : null,
  content: id,
  reasoning,
  html: kind === "reply" ? `<p>${id}</p>` : "",
  status: "done",
  error: null,
  finishReason: null,
  model: kind === "reply" ? "model" : null,
  ttftMs: null,
  thinkingMs: null,
  createdAt: seq,
  finishedAt: seq,
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
      message("r2", 4, "reply"),
      message("u1", 1, "user"),
      message("r1", 2, "reply"),
      message("u2", 3, "user"),
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
        message("r1", 1, "reply", "stored"),
        message("r2", 2, "reply"),
        message("r3", 3, "reply"),
      ],
      new Map([
        ["r2", live("streaming")],
        ["r3", live("")],
      ]),
    );
    expect(rows.map((node) => reply(node).think)).toEqual([true, true, false]);
    expect(reply(rows[1]).live?.reasoning).toBe("streaming");
  });

  test("marks only the final reply as last", () => {
    const rows = groupRows(
      [
        message("u1", 1, "user"),
        message("r1", 2, "reply"),
        message("u2", 3, "user"),
        message("r2", 4, "reply"),
      ],
      new Map(),
    );
    expect(
      rows.filter((node) => node.kind === "reply").map((node) => node.last),
    ).toEqual([false, true]);
  });
});
