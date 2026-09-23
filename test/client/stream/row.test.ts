// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words on a stream row, from the send and the last line the
// server put on it.

import { describe, expect, test } from "bun:test";
import {
  iconOf,
  stateLine,
  tickMs,
  whenText,
} from "../../../src/client/stream/Row.model.ts";
import {
  composeProjectOf,
  emptyLine,
  originOf,
  searchHref,
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
  automationId: null,
  runSource: null,
  forkedFromId: null,
  title: "Which pods restarted",
  status: "done",
  revision: 3,
  createdAt: now - 3_600_000,
  lastActivityAt: now - 12 * 60_000,
  usage: null,
  disabledCapabilities: [],
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
  memoryRound: null,
  memoryError: null,
  memorySkipped: null,
  tokens: 0,
  startedAt: now - 40_000,
  finishedAt: now - 12 * 60_000,
  ...changes,
});

const row = (changes: Partial<StreamRow> = {}): StreamRow => ({
  session: session(),
  agent: "assistant",
  send: send(),
  last: { seq: 2, author: "assistant", text: "nine pods, all expected" },
  automation: null,
  runBy: null,
  runs: null,
  ...changes,
});

// a send that did not finish is credited to the session's agent
const plain = (text: string) => ({ author: "assistant", text });

describe("stateLine", () => {
  test("a done chat shows its last line with the author", () => {
    expect(stateLine(row())).toEqual({
      author: "assistant",
      text: "nine pods, all expected",
    });
    expect(
      stateLine(row({ last: { seq: 1, author: "ana", text: "bump prod?" } })),
    ).toEqual({ author: "ana", text: "bump prod?" });
    expect(stateLine(row({ last: null }))).toEqual({ author: null, text: "" });
  });

  test("a running chat shows the work and its calls", () => {
    const running = session({ status: "running" });
    const active = send({ status: "running", cause: null, finishedAt: null });
    expect(stateLine(row({ session: running, send: active }))).toEqual(
      plain("working"),
    );
    expect(
      stateLine(row({ session: running, send: { ...active, toolCalls: 1 } })),
    ).toEqual(plain("working · 1 tool call"));
    expect(
      stateLine(row({ session: running, send: { ...active, toolCalls: 3 } })),
    ).toEqual(plain("working · 3 tool calls"));
    // the runner has not written the send yet
    expect(stateLine(row({ session: running, send: null }))).toEqual(
      plain("working"),
    );
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
    ).toEqual(plain("failed · openrouter returned 429"));
    expect(
      stateLine(
        row({
          session: failed,
          send: send({ status: "failed", cause: "failure", error: "" }),
        }),
      ),
    ).toEqual(plain("failed"));
    expect(stateLine(row({ session: failed, send: null }))).toEqual(
      plain("failed"),
    );
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
    ).toEqual(plain("stopped"));
    for (const cause of ["shutdown", "restart"] as const) {
      expect(
        stateLine(
          row({ session: stopped, send: send({ status: "stopped", cause }) }),
        ),
      ).toEqual(plain("stopped · the server restarted"));
    }
    expect(
      stateLine(
        row({
          session: stopped,
          send: send({ status: "stopped", cause: "deadline" }),
        }),
      ),
    ).toEqual(plain("stopped · past its deadline"));
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
  test("the composer's project is the pick while listed, else the personal", () => {
    const rows = [
      {
        id: "p2",
        kind: "team" as const,
        name: "platform",
        createdAt: 0,
        memberCount: 1,
      },
      {
        id: "p1",
        kind: "personal" as const,
        name: "personal",
        createdAt: 0,
        memberCount: 1,
      },
    ];
    expect(composeProjectOf(null, null)).toBeNull();
    expect(composeProjectOf(null, "p2")).toBeNull();
    expect(composeProjectOf(rows, null)?.id).toBe("p1");
    expect(composeProjectOf(rows, "p2")?.id).toBe("p2");
    // a project the user no longer sees
    expect(composeProjectOf(rows, "p9")?.id).toBe("p1");
  });

  test("the search is read from the address, trimmed", () => {
    expect(searchOf("")).toBe("");
    expect(searchOf("?q=+pods+")).toBe("pods");
    expect(searchOf("?q=pods+%26+co")).toBe("pods & co");
  });

  test("the filter rides on the address beside the query", () => {
    expect(originOf("")).toBeNull();
    expect(originOf("?origin=automation")).toBe("automation");
    expect(originOf("?origin=chat")).toBe("chat");
    expect(originOf("?origin=other")).toBeNull();
    expect(searchHref("/", "")).toBe("/");
    expect(searchHref("/", " pods ", "automation")).toBe(
      "/?q=pods&origin=automation",
    );
    expect(searchHref("/projects/p1", "", "chat")).toBe(
      "/projects/p1?origin=chat",
    );
  });

  test("the empty line names what the filter hides", () => {
    expect(emptyLine("pods", "chat")).toBe("No sessions match");
    expect(emptyLine("", "chat")).toBe("No chats yet");
    expect(emptyLine("", "automation")).toBe("No task runs yet");
    expect(emptyLine("", null)).toBe("No sessions found");
  });
});

describe("a run's row", () => {
  test("wears the clock, and its line is the agent's like a chat's", () => {
    expect(iconOf(row())).toBe("chat");
    const ran = row({
      session: session({ origin: "automation", automationId: "au1" }),
      automation: { id: "au1", name: "nightly" },
      runBy: null,
    });
    expect(iconOf(ran)).toBe("clock");
    // the title is the automation already, so the line names the agent
    expect(stateLine(ran)).toEqual({
      author: "assistant",
      text: "nine pods, all expected",
    });
  });
});

describe("a row built without its agent", () => {
  test("states a failed send with no author", () => {
    expect(
      stateLine(
        row({
          agent: null,
          session: session({ status: "failed" }),
          send: send({ status: "failed", cause: "failure", error: "quiet" }),
        }),
      ),
    ).toEqual({ author: null, text: "failed · quiet" });
  });
});
