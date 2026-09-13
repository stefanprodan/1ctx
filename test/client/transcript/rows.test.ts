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
  endedBy,
  groupRows,
  type Node,
  type ReplyNode,
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
  return node.kind === "reply" ? node.sendId : node.message.sendId;
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
    const summary = rows.find((row) => row.kind === "summary");
    // a compact send has no user row: its turn is the summary alone
    if (expectedUser === undefined) {
      if (summary === undefined) {
        throw new Error(`${name}:${step}:${sendId}: no user row`);
      }
      expect(rows.map((row) => row.kind)).toEqual(["summary"]);
      expect(sendNodes.map((node) => node.kind)).toEqual(["reply"]);
      const node = sendNodes[0];
      if (node?.kind !== "reply") throw new Error("expected reply node");
      expect(node.compact).toBeTrue();
      expect(node.summary?.id).toBe(summary.id);
      expect(node.message).toBeNull();
      expect(node.work).toBeNull();
      expect(endedBy(node)).toBeNull();
      if (summary.status === "streaming") {
        expect(live.value.has(summary.id)).toBeTrue();
      } else expect(live.value.has(summary.id)).toBeFalse();
      continue;
    }
    // the agent's turn holds the work and the answer; a send with
    // neither has only its user row
    const expectedKinds: Node["kind"][] = ["user"];
    if (workRows.length > 0 || expectedReply !== undefined) {
      expectedKinds.push("reply");
    }

    expect(sendNodes.map((node) => node.kind)).toEqual(expectedKinds);
    const userNode = sendNodes[0];
    expect(userNode?.kind).toBe("user");
    if (userNode?.kind === "user") {
      expect(userNode.message.id).toBe(expectedUser.id);
    }

    const reply = sendNodes.find((node) => node.kind === "reply");
    if (reply?.kind === "reply") {
      expect(reply.rows.map((row) => row.id)).toEqual(
        rows.map((row) => row.id),
      );
      expect(reply.compact).toBeFalse();
      // the summary sits on the turn after its answer, and streams
      // like a reply
      expect(reply.summary?.id ?? null).toBe(summary?.id ?? null);
      if (summary !== undefined) {
        expect(summary.seq).toBeGreaterThan(answer?.seq ?? 0);
        expect(live.value.has(summary.id)).toBe(summary.status === "streaming");
      }
    }
    if (expectedReply === undefined) {
      expect(reply?.message ?? null).toBeNull();
    } else {
      expect(reply?.kind).toBe("reply");
      if (reply?.kind === "reply") {
        expect(reply.message?.id).toBe(expectedReply.id);
        expect(
          reply.message?.slot === "answer" ||
            (reply.message?.slot === null &&
              reply.message.status === "streaming"),
        ).toBeTrue();
      }
    }

    const work = reply?.kind === "reply" ? reply.work : null;
    if (workRows.length === 0) {
      expect(work).toBeNull();
      continue;
    }
    if (work === null || work === undefined) {
      throw new Error(`${name}:${step}:${sendId}: no work`);
    }
    expect(work.answer?.id ?? null).toBe(answer?.id ?? null);
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
  kind: "user" | "reply" | "tool" | "summary",
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
  agentId: kind === "user" || kind === "tool" ? null : "a1",
  content: id,
  resultBytes: null,
  promptTokens: null,
  reasoning: "",
  html: kind === "user" || kind === "tool" ? "" : `<p>${id}</p>`,
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

const replyNode = (nodes: Node[]): ReplyNode => {
  const node = nodes.find((item) => item.kind === "reply");
  if (node?.kind !== "reply") throw new Error("expected reply node");
  return node;
};

const workNode = (nodes: Node[]): WorkNode => {
  const work = replyNode(nodes).work;
  if (work === null) throw new Error("expected work");
  return work;
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

  test("puts the work in the agent's turn and pairs duplicate call ids once", () => {
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
    expect(nodes.map((node) => node.kind)).toEqual(["user", "reply"]);
    expect(replyNode(nodes).message?.id).toBe("answer");
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

  test("keeps work while a send is between rounds", () => {
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

    const reply = replyNode(nodes);
    expect(reply.message).toBeNull();
    expect(reply.work).not.toBeNull();
    expect(reply.work?.rows.map((row) => row.id)).toEqual(["work"]);
    expect(reply.work?.rounds[0]?.calls[0]?.result).toBeNull();
  });

  test("puts the summary after the answer and a compact send on its own", () => {
    const nodes = groupRows([
      message("user", 1, "user"),
      message("answer", 2, "reply"),
      message("summary", 3, "summary", { round: 2, promptTokens: 41_000 }),
      message("compacted", 4, "summary", {
        sendId: "send2",
        status: "failed",
        error: "the summary came back empty",
      }),
    ]);
    expect(nodes.map((node) => node.kind)).toEqual(["user", "reply", "reply"]);
    const turn = replyNode(nodes);
    expect(turn.message?.id).toBe("answer");
    expect(turn.summary?.id).toBe("summary");
    expect(turn.compact).toBeFalse();
    const compact = nodes[2];
    if (compact?.kind !== "reply") throw new Error("expected reply node");
    expect(compact.compact).toBeTrue();
    expect(compact.message).toBeNull();
    expect(compact.work).toBeNull();
    expect(compact.summary?.id).toBe("compacted");
    // a failed summary shows in its fold, never as the turn's cut line
    expect(endedBy(compact)).toBeNull();
    expect(endedBy(turn)?.id).toBe("answer");
  });

  test("takes a stopped work turn's ending from its tool row", () => {
    const nodes = groupRows([
      message("user", 1, "user"),
      message("work", 2, "reply", {
        slot: "work",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call-1",
            name: "websearch",
            arguments: '{"query":"where"}',
          },
        ],
      }),
      message("tool", 3, "tool", {
        status: "stopped",
        toolCallId: "call-1",
        toolName: "websearch",
      }),
    ]);

    const reply = replyNode(nodes);
    expect(reply.message).toBeNull();
    expect(endedBy(reply)?.id).toBe("tool");
    expect(endedBy(reply)?.status).toBe("stopped");
  });
});
