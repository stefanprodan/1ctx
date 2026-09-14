// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a stream row, from the send and the last line the
// server put on it.

import { describe, expect, test } from "bun:test";
import {
  stateLine,
  tickMs,
  whenText,
} from "../../../src/client/stream/Row.model.ts";
import {
  personalOf,
  searchOf,
} from "../../../src/client/views/home/Home.model.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import type {
  SendSummary,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";

const now = new Date(2026, 8, 13, 12).getTime();

const session = (changes: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  projectId: "p1",
  ownerId: "u1",
  agentId: "a1",
  origin: "chat",
  title: "Which pods restarted",
  status: "done",
  revision: 3,
  createdAt: now - 3_600_000,
  lastActivityAt: now - 12 * 60_000,
  usage: null,
  ...changes,
});

const send = (changes: Partial<SendSummary> = {}): SendSummary => ({
  id: "send1",
  sessionId: "s1",
  kind: "chat",
  userId: "u1",
  agentId: "a1",
  providerId: "pr1",
  model: "small",
  status: "done",
  cause: "finish",
  error: null,
  firstMessageId: "m1",
  rounds: 1,
  toolCalls: 0,
  startedAt: now - 40_000,
  finishedAt: now - 12 * 60_000,
  ...changes,
});

const row = (changes: Partial<StreamRow> = {}): StreamRow => ({
  session: session(),
  send: send(),
  last: { seq: 2, author: "assistant", text: "nine pods, all expected" },
  ...changes,
});

describe("stateLine", () => {
  test("a done chat shows its last line with the author", () => {
    expect(stateLine(row())).toBe("assistant: nine pods, all expected");
    expect(
      stateLine(row({ last: { seq: 1, author: "ana", text: "bump prod?" } })),
    ).toBe("ana: bump prod?");
    expect(stateLine(row({ last: null }))).toBe("");
  });

  test("a running chat shows the work and its calls", () => {
    const running = session({ status: "running" });
    const active = send({ status: "running", cause: null, finishedAt: null });
    expect(stateLine(row({ session: running, send: active }))).toBe("working");
    expect(
      stateLine(row({ session: running, send: { ...active, toolCalls: 1 } })),
    ).toBe("working · 1 tool call");
    expect(
      stateLine(row({ session: running, send: { ...active, toolCalls: 3 } })),
    ).toBe("working · 3 tool calls");
    // the runner has not written the send yet
    expect(stateLine(row({ session: running, send: null }))).toBe("working");
  });

  test("a failed chat shows the first line of the error", () => {
    const failed = session({ status: "failed" });
    expect(
      stateLine(
        row({
          session: failed,
          send: send({
            status: "failed",
            cause: "failure",
            error: "openrouter returned 429\nretry later",
          }),
        }),
      ),
    ).toBe("failed · openrouter returned 429");
    expect(
      stateLine(
        row({
          session: failed,
          send: send({ status: "failed", cause: "failure", error: "" }),
        }),
      ),
    ).toBe("failed");
    expect(stateLine(row({ session: failed, send: null }))).toBe("failed");
  });

  test("a stopped chat says who, the person or the server", () => {
    const stopped = session({ status: "stopped" });
    expect(
      stateLine(
        row({
          session: stopped,
          send: send({ status: "stopped", cause: "stop" }),
        }),
      ),
    ).toBe("stopped");
    for (const cause of ["shutdown", "restart"] as const) {
      expect(
        stateLine(
          row({ session: stopped, send: send({ status: "stopped", cause }) }),
        ),
      ).toBe("stopped · the server restarted");
    }
  });
});

describe("whenText", () => {
  test("a running row shows the send's elapsed time", () => {
    const running = row({
      session: session({ status: "running" }),
      send: send({ status: "running", startedAt: now - 40_000 }),
    });
    expect(whenText(running, now)).toBe("40s");
    expect(whenText({ ...running, send: null }, now)).toBe("12m");
  });

  test("any other row shows how long ago it moved", () => {
    expect(whenText(row(), now)).toBe("12m ago");
  });

  test("the clock ticks every second only while a row runs", () => {
    expect(tickMs(null)).toBe(30_000);
    expect(tickMs([row()])).toBe(30_000);
    expect(
      tickMs([row(), row({ session: session({ status: "running" }) })]),
    ).toBe(1000);
  });
});

describe("Home.model", () => {
  test("the personal project is the one of its kind in the list", () => {
    expect(personalOf(null)).toBeNull();
    expect(
      personalOf([
        {
          id: "p2",
          kind: "team",
          name: "platform",
          createdAt: 0,
          memberCount: 1,
        },
        {
          id: "p1",
          kind: "personal",
          name: "caelea",
          createdAt: 0,
          memberCount: 1,
        },
      ])?.id,
    ).toBe("p1");
  });

  test("the search is read from the address, trimmed", () => {
    expect(searchOf("")).toBe("");
    expect(searchOf("?q=+pods+")).toBe("pods");
    expect(searchOf("?q=pods+%26+co")).toBe("pods & co");
  });
});
