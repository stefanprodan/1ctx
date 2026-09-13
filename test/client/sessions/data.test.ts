// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { path, query } from "../../../src/client/app/router.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  BUFFER_MAX,
  compactSession,
  deleteSession,
  leaveSession,
  live,
  loadProjectSessions,
  loadSession,
  onSocket,
  projectAgents,
  projectSessions,
  renameSession,
  sending,
  session,
  sessionError,
  toolResults,
} from "../../../src/client/data/sessions.ts";
import type {
  Message,
  SendSummary,
  SessionDetail,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";

function summary(changes: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s1",
    projectId: "p1",
    ownerId: "u1",
    agentId: "a1",
    origin: "chat",
    title: "Chat",
    status: "done",
    revision: 1,
    createdAt: 10,
    lastActivityAt: 20,
    usage: null,
    ...changes,
  };
}

function message(changes: Partial<Message> = {}): Message {
  return {
    id: "m1",
    sessionId: "s1",
    seq: 1,
    kind: "reply",
    sendId: "send1",
    round: 1,
    slot: "answer",
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    userId: null,
    agentId: "a1",
    content: "",
    resultBytes: null,
    promptTokens: null,
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: "stop",
    model: "small",
    ttftMs: null,
    thinkingMs: null,
    createdAt: 10,
    finishedAt: 20,
    ...changes,
  };
}

function detail(
  id = "s1",
  changes: Partial<SessionDetail> = {},
): SessionDetail {
  return {
    session: summary({ id }),
    messages: [],
    send: null,
    live: null,
    ...changes,
  };
}

function liveDetail(): SessionDetail {
  const reply = message({
    status: "streaming",
    slot: null,
    finishReason: null,
  });
  return detail("s1", {
    session: summary({ status: "running" }),
    messages: [reply],
    live: {
      phase: "reply",
      sendId: "send1",
      messageId: reply.id,
      seq: 0,
      content: "",
      reasoning: "",
      html: "",
      htmlAt: 0,
    },
  });
}

const sent: SendSummary = {
  id: "send1",
  sessionId: "s1",
  kind: "chat",
  userId: "u1",
  agentId: "a1",
  providerId: "provider1",
  model: "small",
  status: "running",
  cause: null,
  error: null,
  firstMessageId: "m0",
  rounds: 1,
  toolCalls: 0,
  startedAt: 10,
  finishedAt: null,
};

const realFetch = globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const realHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
let user = 0;
let pushed: string[] = [];

function restoreGlobal(
  name: "location" | "history",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
  else Object.defineProperty(globalThis, name, descriptor);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  user++;
  me.value = {
    id: `u${user}`,
    username: "oana",
    fullName: "Oana",
    role: "member",
  };
  pushed = [];
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      origin: "http://test.invalid",
      pathname: "/",
      search: "",
    },
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      pushState: (_state: unknown, _unused: string, target: string) => {
        pushed.push(target);
      },
      replaceState: () => {},
    },
  });
  path.value = "/";
  query.value = "";
  answer = (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(async () => {
  leaveSession();
  me.value = undefined;
  await settle();
  globalThis.fetch = realFetch;
  restoreGlobal("location", realLocation);
  restoreGlobal("history", realHistory);
});

describe("the sessions entity", () => {
  test("an older detail answer never overwrites the newer turn", async () => {
    const gates: ((value: SessionDetail) => void)[] = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        gates.push((value) => resolve(Response.json(value)));
      })) as unknown as typeof fetch;

    const first = loadSession("s1");
    const second = loadSession("s2");
    gates[1](detail("s2"));
    await second;
    expect(session.value?.session.id).toBe("s2");

    gates[0](detail("s1"));
    await first;
    expect(session.value?.session.id).toBe("s2");
  });

  test("a detail failure sets the session error", async () => {
    answer = () => Response.json({ error: "gone" }, { status: 404 });

    await loadSession("s1");

    expect(sessionError.value).toBe("gone");
  });

  test("loads running sessions first, then newest activity", async () => {
    answer = () =>
      Response.json({
        sessions: [
          summary({ id: "old", lastActivityAt: 10 }),
          summary({ id: "running", status: "running", lastActivityAt: 1 }),
          summary({ id: "new", lastActivityAt: 30 }),
        ],
      });

    await loadProjectSessions("p1");

    expect(projectSessions.value?.map((row) => row.id)).toEqual([
      "running",
      "new",
      "old",
    ]);
  });

  test("a newer envelope replaces rows and older revisions are ignored", () => {
    session.value = detail("s1", {
      messages: [
        message({ id: "m1", seq: 1, content: "old" }),
        message({ id: "m3", seq: 3 }),
      ],
    });
    const next = summary({ revision: 2, title: "New" });

    onSocket({
      type: "session",
      projectId: "p1",
      session: next,
      messages: [
        message({ id: "m2", seq: 2 }),
        message({ id: "m1", seq: 1, content: "new" }),
      ],
      send: sent,
    });

    expect(session.value?.session).toEqual(next);
    expect(session.value?.messages.map((row) => row.id)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
    expect(session.value?.messages[0].content).toBe("new");
    expect(session.value?.send).toEqual(sent);

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, title: "Ignored" }),
      messages: [message({ id: "m4", seq: 4 })],
      send: null,
    });
    expect(session.value?.session.title).toBe("New");
    expect(session.value?.messages).toHaveLength(3);
  });

  test("an envelope updates the loaded project's list", async () => {
    answer = () => Response.json({ sessions: [summary()] });
    await loadProjectSessions("p1");

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, title: "Changed" }),
      messages: [],
      send: null,
    });

    expect(projectSessions.value?.[0].title).toBe("Changed");
  });

  test("streaming replies enter the live map and done replies leave", () => {
    session.value = detail();
    const streaming = message({ status: "streaming", finishReason: null });

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, status: "running" }),
      messages: [streaming],
      send: sent,
    });
    expect(live.value.has(streaming.id)).toBe(true);

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 3 }),
      messages: [message({ id: streaming.id })],
      send: { ...sent, status: "done", cause: "finish", finishedAt: 30 },
    });
    expect(live.value.has(streaming.id)).toBe(false);
  });

  test("a streaming summary row enters the live map like a reply", () => {
    session.value = detail();
    const streaming = message({
      id: "sum1",
      kind: "summary",
      slot: null,
      round: 2,
      status: "streaming",
      finishReason: null,
    });
    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, status: "running" }),
      messages: [streaming],
      send: sent,
    });
    expect(live.value.has("sum1")).toBe(true);
    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 3 }),
      messages: [message({ ...streaming, status: "done", promptTokens: 40 })],
      send: { ...sent, status: "done", cause: "finish", finishedAt: 30 },
    });
    expect(live.value.has("sum1")).toBe(false);
    expect(session.value?.messages[0]?.promptTokens).toBe(40);
  });

  test("a detail's streaming summary row seeds live from the snapshot", async () => {
    const row = message({
      id: "sum1",
      kind: "summary",
      slot: null,
      status: "streaming",
      finishReason: null,
    });
    answer = () =>
      Response.json(
        detail("s1", {
          session: summary({ status: "running" }),
          messages: [row],
          live: {
            phase: "reply",
            sendId: "send1",
            messageId: "sum1",
            seq: 2,
            content: "## Goal",
            reasoning: "",
            html: "",
            htmlAt: 0,
          },
        }),
      );
    await loadSession("s1");
    expect(live.value.get("sum1")?.content).toBe("## Goal");
  });

  test("compact posts to the session and takes the detail", async () => {
    session.value = detail();
    let hit = "";
    answer = (url, init) => {
      hit = `${init?.method ?? "GET"} ${url}`;
      return Response.json(detail("s1", { session: summary({ revision: 5 }) }));
    };
    await compactSession("s1");
    expect(hit).toBe("POST /api/sessions/s1/compact");
    expect(session.value?.session.revision).toBe(5);
    expect(sending.value).toBe(false);
  });

  test("rename patches the title and takes the detail", async () => {
    session.value = detail();
    projectSessions.value = [summary()];
    let hit = "";
    let sent: unknown = null;
    let busy = false;
    answer = (url, init) => {
      hit = `${init?.method ?? "GET"} ${url}`;
      sent = JSON.parse(String(init?.body));
      busy = sending.value;
      return Response.json(
        detail("s1", {
          session: summary({ title: "Kept As Typed", revision: 5 }),
        }),
      );
    };
    await renameSession("s1", "Kept As Typed");
    expect(hit).toBe("PATCH /api/sessions/s1");
    // the composer is busy for the call, as for a send
    expect(busy).toBe(true);
    expect(sending.value).toBe(false);
    expect(sent).toEqual({ title: "Kept As Typed" });
    expect(session.value?.session.title).toBe("Kept As Typed");
    expect(session.value?.session.revision).toBe(5);
  });

  test("delete drops the row, leaves the chat and opens its project", async () => {
    session.value = liveDetail();
    projectSessions.value = [summary(), summary({ id: "s2" })];
    path.value = "/chat/s1";
    let hit = "";
    answer = (url, init) => {
      hit = `${init?.method ?? "GET"} ${url}`;
      return Response.json({});
    };
    await deleteSession("s1", "p1");
    expect(hit).toBe("DELETE /api/sessions/s1");
    expect(session.value).toBeNull();
    expect(live.value.size).toBe(0);
    expect(projectSessions.value?.map((s) => s.id)).toEqual(["s2"]);
    expect(pushed).toEqual(["/projects/p1"]);
    // the socket's frame for the same delete finds nothing to do
    onSocket({ type: "deleted", projectId: "p1", sessionId: "s1" });
    expect(pushed).toEqual(["/projects/p1"]);
  });

  test("a deletion drops a detail answer still in flight", async () => {
    path.value = "/chat/s1";
    let release: (r: Response) => void = () => {};
    answer = () => new Promise((r) => (release = r));
    const load = loadSession("s1");
    onSocket({ type: "deleted", projectId: "p1", sessionId: "s1" });
    expect(pushed).toEqual(["/projects/p1"]);
    release(Response.json(detail()));
    await load;
    expect(session.value).toBeNull();
    expect(live.value.size).toBe(0);
  });

  test("a deletion off screen loads the project's list again", async () => {
    projectSessions.value = null;
    const calls: string[] = [];
    answer = (url) => {
      calls.push(url);
      return Response.json({ sessions: [summary({ id: "s2" })] });
    };
    await loadProjectSessions("p1");
    onSocket({ type: "deleted", projectId: "p1", sessionId: "s2" });
    await settle();
    expect(calls).toEqual([
      "/api/sessions?project=p1",
      "/api/sessions?project=p1",
    ]);
  });

  test("a watched snapshot seeds live and applies newer buffered frames", async () => {
    const base = liveDetail();
    answer = () => Response.json(base);
    await loadSession("s1");
    onSocket({
      type: "delta",
      sessionId: "s1",
      sendId: "send1",
      messageId: "m1",
      seq: 2,
      content: "B",
      contentAt: 1,
      reasoningAt: 0,
    });

    onSocket({
      type: "watched",
      sessionId: "s1",
      live: {
        phase: "reply",
        sendId: "send1",
        messageId: "m1",
        seq: 1,
        content: "A",
        reasoning: "",
        html: "",
        htmlAt: 0,
      },
    });

    expect(live.value.get("m1")?.content).toBe("AB");
  });

  test("a work-slot envelope keeps the reply's live buffer", async () => {
    const base = liveDetail();
    if (base.live?.phase === "reply") base.live.content = "streaming text";
    answer = () => Response.json(base);
    await loadSession("s1");
    onSocket({ type: "watched", sessionId: "s1", live: base.live });

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, status: "running" }),
      messages: [
        message({ status: "streaming", slot: "work", finishReason: null }),
      ],
      send: sent,
    });
    onSocket({
      type: "delta",
      sessionId: "s1",
      sendId: "send1",
      messageId: "m1",
      seq: 1,
      content: " continues",
      contentAt: "streaming text".length,
      reasoningAt: 0,
    });

    expect(session.value?.messages[0]?.slot).toBe("work");
    expect(live.value.get("m1")?.content).toBe("streaming text continues");
  });

  test("a watched tools phase neither seeds live nor refetches", async () => {
    let fetches = 0;
    const base = detail("s1", {
      session: summary({ status: "running" }),
      messages: [
        message({
          slot: "work",
          status: "done",
          finishReason: "tool_calls",
        }),
        message({
          id: "tool1",
          seq: 2,
          kind: "tool",
          slot: null,
          status: "streaming",
          finishReason: null,
          agentId: null,
          toolCallId: "c1",
          toolName: "get_current_time",
        }),
      ],
      send: sent,
      live: { phase: "tools", sendId: "send1", seq: 3 },
    });
    answer = () => {
      fetches++;
      return Response.json(base);
    };
    await loadSession("s1");

    onSocket({
      type: "watched",
      sessionId: "s1",
      live: { phase: "tools", sendId: "send1", seq: 3 },
    });
    await settle();

    expect(fetches).toBe(1);
    expect(live.value.size).toBe(0);
  });

  test("a delta before watched is buffered", async () => {
    const base = liveDetail();
    base.live = null;
    answer = () => Response.json(base);
    await loadSession("s1");

    onSocket({
      type: "delta",
      sessionId: "s1",
      sendId: "send1",
      messageId: "m1",
      seq: 1,
      content: "A",
      contentAt: 0,
      reasoningAt: 0,
    });
    expect(live.value.get("m1")?.content).toBe("");

    onSocket({ type: "watched", sessionId: "s1", live: null });
    expect(live.value.get("m1")?.content).toBe("A");
  });

  test("a sequence gap refetches the detail", async () => {
    let fetches = 0;
    const base = liveDetail();
    answer = () => {
      fetches++;
      return Response.json(base);
    };
    await loadSession("s1");
    onSocket({ type: "watched", sessionId: "s1", live: base.live });

    onSocket({
      type: "delta",
      sessionId: "s1",
      sendId: "send1",
      messageId: "m1",
      seq: 2,
      content: "gap",
      contentAt: 1,
      reasoningAt: 0,
    });

    expect(fetches).toBe(2);
    await settle();
  });

  test("buffer overflow refetches the detail", async () => {
    let fetches = 0;
    const base = liveDetail();
    answer = () => {
      fetches++;
      return Response.json(base);
    };
    await loadSession("s1");

    for (let seq = 1; seq <= BUFFER_MAX + 1; seq++) {
      onSocket({
        type: "delta",
        sessionId: "s1",
        sendId: "send1",
        messageId: "m1",
        seq,
        content: "x",
        contentAt: seq - 1,
        reasoningAt: 0,
      });
    }
    onSocket({ type: "watched", sessionId: "s1", live: base.live });

    expect(fetches).toBe(2);
    await settle();
  });

  test("a delta for a session off screen changes nothing", async () => {
    const base = liveDetail();
    answer = () => Response.json(base);
    await loadSession("s1");
    onSocket({ type: "watched", sessionId: "s1", live: base.live });
    const before = live.value;

    onSocket({
      type: "delta",
      sessionId: "s2",
      sendId: "send2",
      messageId: "m2",
      seq: 1,
      content: "other",
      contentAt: 0,
      reasoningAt: 0,
    });

    expect(live.value).toBe(before);
  });

  test("a held tool result goes with its row", () => {
    session.value = detail("s1", {
      messages: [
        message({ id: "m1", seq: 1, kind: "user" }),
        message({ id: "t1", seq: 2, kind: "tool" }),
        message({ id: "t2", seq: 3, kind: "tool" }),
      ],
    });
    const held = {
      status: "done" as const,
      content: "x",
      bytes: 1,
      cut: false,
    };
    toolResults.value = new Map([
      ["t1", held],
      ["t2", held],
    ]);

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2 }),
      messages: [message({ id: "m2", seq: 4, kind: "user" })],
      removedMessageIds: ["t2"],
      send: sent,
    });
    expect([...toolResults.value.keys()]).toEqual(["t1"]);

    onSocket({ type: "deleted", projectId: "p1", sessionId: "s1" });
    expect(toolResults.value.size).toBe(0);
  });

  test("deleting the session on screen clears it and opens its project", () => {
    session.value = liveDetail();
    path.value = "/chat/s1";

    onSocket({ type: "deleted", projectId: "p1", sessionId: "s1" });

    expect(session.value).toBeNull();
    expect(live.value.size).toBe(0);
    expect(pushed).toEqual(["/projects/p1"]);
    expect(path.value).toBe("/projects/p1");
  });

  test("revoking the project on screen clears its session", () => {
    session.value = liveDetail();
    path.value = "/chat/s1";

    onSocket({ type: "revoked", projectId: "p1" });

    expect(session.value).toBeNull();
    expect(live.value.size).toBe(0);
    expect(path.value).toBe("/");
  });

  test("drops every session entity when the signed-in user changes", () => {
    session.value = liveDetail();
    sessionError.value = "old";
    live.value = new Map([
      [
        "m1",
        {
          content: "x",
          reasoning: "",
          html: "",
          htmlAt: 0,
          thinkStart: null,
          thinkEnd: null,
          thinkMs: null,
        },
      ],
    ]);
    projectSessions.value = [summary()];
    projectAgents.value = [];
    sending.value = true;

    me.value = {
      id: "another-user",
      username: "ana",
      fullName: "Ana",
      role: "member",
    };

    expect(session.value).toBeNull();
    expect(sessionError.value).toBeNull();
    expect(live.value.size).toBe(0);
    expect(projectSessions.value).toBeNull();
    expect(projectAgents.value).toBeNull();
    expect(sending.value).toBe(false);
  });
});
