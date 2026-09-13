// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { me } from "../../../src/client/data/me.ts";
import {
  leaveSession,
  live,
  loadSession,
  onSocket,
  session,
} from "../../../src/client/data/sessions.ts";
import {
  groupRows,
  type Node,
  type WorkNode,
} from "../../../src/client/transcript/rows.ts";
import type {
  Message,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "socket");

type FixtureStart = {
  kind: "detail" | "fetched";
  detail: SessionDetail;
};

const realFetch = globalThis.fetch;
let initial: SessionDetail | null = null;
let user = 0;

beforeEach(() => {
  user++;
  me.value = {
    id: `fixture-user-${user}`,
    username: "fixture-user",
    fullName: "Fixture User",
    role: "member",
  };
  initial = null;
  globalThis.fetch = (async () => {
    if (initial === null) throw new Error("fixture detail not set");
    return Response.json(initial);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  leaveSession();
  me.value = undefined;
  globalThis.fetch = realFetch;
});

function nodeSendId(node: Node): string {
  return node.kind === "work" ? node.sendId : node.message.sendId;
}

function invariant(name: string, step: number): void {
  const detail = session.value;
  if (detail === null) throw new Error(`${name}:${step}: no session`);
  const nodes = groupRows(detail.messages, detail.send);
  const sendIds = [
    ...new Set(
      [...detail.messages]
        .sort((left, right) => left.seq - right.seq)
        .map((message) => message.sendId),
    ),
  ];

  for (const sendId of sendIds) {
    const rows = detail.messages
      .filter((message) => message.sendId === sendId)
      .toSorted((left, right) => left.seq - right.seq);
    const sendNodes = nodes.filter((node) => nodeSendId(node) === sendId);
    const workRows = rows.filter(
      (row) =>
        (row.kind === "reply" && row.slot === "work") || row.kind === "tool",
    );
    const answer = rows.find(
      (row) => row.kind === "reply" && row.slot === "answer",
    );
    const streaming = rows.find(
      (row) =>
        row.kind === "reply" && row.slot === null && row.status === "streaming",
    );
    const expectedReply = answer ?? streaming;
    const expectedUser = rows.find((row) => row.kind === "user");
    if (expectedUser === undefined) {
      throw new Error(`${name}:${step}:${sendId}: no user row`);
    }
    const expectedKinds: Node["kind"][] = ["user"];
    if (workRows.length > 0) expectedKinds.push("work");
    if (expectedReply !== undefined) expectedKinds.push("reply");

    expect(sendNodes.map((node) => node.kind)).toEqual(expectedKinds);
    const userNode = sendNodes[0];
    expect(userNode?.kind).toBe("user");
    if (userNode?.kind === "user") {
      expect(userNode.message.id).toBe(expectedUser.id);
    }

    const reply = sendNodes.find((node) => node.kind === "reply");
    if (expectedReply === undefined) {
      expect(reply).toBeUndefined();
    } else {
      expect(reply?.kind).toBe("reply");
      if (reply?.kind === "reply") {
        expect(reply.message.id).toBe(expectedReply.id);
        expect(
          reply.message.slot === "answer" ||
            (reply.message.slot === null &&
              reply.message.status === "streaming"),
        ).toBeTrue();
      }
    }

    const work = sendNodes.find((node) => node.kind === "work");
    if (workRows.length === 0) {
      expect(work).toBeUndefined();
      continue;
    }
    expect(work?.kind).toBe("work");
    if (work?.kind !== "work") continue;
    expect(work.rows.map((row) => row.id)).toEqual(
      workRows.map((row) => row.id),
    );
    expect(work.rounds.map((round) => round.message.id)).toEqual(
      workRows.filter((row) => row.kind === "reply").map((row) => row.id),
    );
    const paired = new Set<string>();
    for (const round of work.rounds) {
      for (const call of round.calls) {
        if (call.result === null) continue;
        expect(call.result.round).toBe(round.message.round);
        expect(call.result.toolCallId).toBe(call.call.id);
        expect(paired.has(call.result.id)).toBeFalse();
        paired.add(call.result.id);
      }
      if (round.message.status === "streaming") {
        expect(live.value.has(round.message.id)).toBeTrue();
      }
    }
    for (const row of work.rows.filter((item) => item.kind === "tool")) {
      expect(paired.has(row.id)).toBeTrue();
    }
  }
}

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

const workNode = (nodes: Node[]): WorkNode => {
  const node = nodes.find((item) => item.kind === "work");
  if (node?.kind !== "work") throw new Error("expected work node");
  return node;
};

describe("transcript rows", () => {
  test("replays every socket fixture through the session reducers", async () => {
    const names = readdirSync(FIXTURES)
      .filter((name) => name.endsWith(".ndjson"))
      .sort();
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      leaveSession();
      const lines = (await Bun.file(join(FIXTURES, name)).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const start = lines[0] as FixtureStart;
      initial = start.detail;
      await loadSession(start.detail.session.id);
      invariant(name, 0);
      for (let index = 1; index < lines.length; index++) {
        onSocket(lines[index] as SocketEvent);
        invariant(name, index);
      }
    }
  });

  test("orders the three node kinds and pairs duplicate call ids once", () => {
    const messages = [
      message("answer", 6, "reply", { round: 2 }),
      message("tool-2", 4, "tool", {
        slot: null,
        toolCallId: "dup",
        toolName: "get_current_time",
      }),
      message("user", 1, "user"),
      message("work", 2, "reply", {
        slot: "work",
        toolCalls: [
          { id: "dup", name: "get_current_time", arguments: "{}" },
          { id: "dup", name: "get_current_time", arguments: "{}" },
        ],
      }),
      message("tool-1", 3, "tool", {
        slot: null,
        toolCallId: "dup",
        toolName: "get_current_time",
      }),
    ];

    const nodes = groupRows(messages);
    expect(nodes.map((node) => node.kind)).toEqual(["user", "work", "reply"]);
    const work = workNode(nodes);
    expect(work.rows.map((row) => row.id)).toEqual([
      "work",
      "tool-1",
      "tool-2",
    ]);
    expect(work.rounds[0]?.calls.map((call) => call.result?.id)).toEqual([
      "tool-1",
      "tool-2",
    ]);
    expect(messages.map((row) => row.id)).toEqual([
      "answer",
      "tool-2",
      "user",
      "work",
      "tool-1",
    ]);
  });

  test("keeps a call without a result as not run", () => {
    const nodes = groupRows([
      message("user", 1, "user"),
      message("work", 2, "reply", {
        slot: "work",
        toolCalls: [
          {
            id: "cut",
            name: "websearch",
            arguments: '{"query":"where"}',
          },
        ],
      }),
    ]);

    expect(workNode(nodes).rounds[0]?.calls[0]?.result).toBeNull();
  });
});
