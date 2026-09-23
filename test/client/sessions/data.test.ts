// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { path, query } from "../../../src/client/app/router.ts";
import {
  changeOf,
  dropFlips,
  flip,
  switchable,
} from "../../../src/client/data/capabilities.ts";
import { forking, forkSession } from "../../../src/client/data/fork.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  BUFFER_MAX,
  compactSession,
  createSession,
  deleteSession,
  leaveSession,
  list,
  live,
  loadList,
  loadMore,
  loadProjectAgents,
  loadSession,
  onSocket,
  projectAgents,
  regenerateSession,
  renameSession,
  sending,
  sendMessage,
  session,
  sessionError,
  toolResults,
} from "../../../src/client/data/sessions.ts";
import {
  applyAutomationFrame,
  IDLE,
  type StreamList,
} from "../../../src/client/data/stream.ts";
import type { StreamRow } from "../../../src/shared/api/sessions.ts";
import { WEB } from "../../../src/shared/capabilities.ts";
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
    automationId: null,
    runSource: null,
    forkedFromId: null,
    title: "Chat",
    status: "done",
    revision: 1,
    createdAt: 10,
    lastActivityAt: 20,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  };
}

function row(changes: Partial<SessionSummary> = {}): StreamRow {
  return {
    session: summary(changes),
    agent: "assistant",
    send: null,
    last: null,
    automation: null,
    runBy: null,
    runs: null,
  };
}

const ids = (rows: StreamRow[] | StreamList | null | undefined) =>
  (Array.isArray(rows) ? rows : rows?.rows)?.map((r) => r.session.id);

const page = (rows: StreamRow[], next: string | null = null): StreamList => ({
  rows,
  next,
  more: IDLE,
});

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
    uploads: null,
    files: null,
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
    forkedFrom: null,
    messages: [],
    send: null,
    live: null,
    authors: [],
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
  memoryRound: null,
  memoryError: null,
  memorySkipped: null,
  tokens: 0,
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
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
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

    expect(sessionError.value?.words).toBe("gone");
  });

  test("loads running sessions first, then newest activity", async () => {
    const urls: string[] = [];
    answer = (url) => {
      urls.push(url);
      return Response.json({
        rows: [
          row({ id: "old", lastActivityAt: 10 }),
          row({ id: "running", status: "running", lastActivityAt: 1 }),
          row({ id: "new", lastActivityAt: 30 }),
        ],
      });
    };

    await loadList({ project: "p1", q: "" });

    expect(urls).toEqual(["/api/sessions?project=p1"]);
    expect(ids(list.value)).toEqual(["running", "new", "old"]);
  });

  test("the stream's filter is the query, and a new filter drops the rows", async () => {
    const urls: string[] = [];
    answer = (url) => {
      urls.push(url);
      return Response.json({ rows: [row()] });
    };
    await loadList({ project: null, q: "" });
    expect(list.value?.rows).toHaveLength(1);
    let seen: StreamList | null | undefined;
    answer = (url) => {
      urls.push(url);
      seen = list.value;
      return Response.json({ rows: [] });
    };
    await loadList({ project: null, q: "pods & co" });
    expect(seen).toBeNull();
    expect(list.value?.rows).toEqual([]);
    expect(urls).toEqual(["/api/sessions", "/api/sessions?q=pods+%26+co"]);
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
    answer = () => Response.json({ rows: [row()] });
    await loadList({ project: "p1", q: "" });

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, title: "Changed" }),
      messages: [],
      send: null,
    });

    expect(list.value?.rows[0].session.title).toBe("Changed");
  });

  test("automation frames rename and clear loaded run labels", async () => {
    answer = () =>
      Response.json({
        rows: [
          {
            ...row({ origin: "automation", automationId: "au1" }),
            automation: { id: "au1", name: "old-name" },
          },
        ],
      });
    await loadList({ project: "p1", q: "" });

    applyAutomationFrame({
      type: "automation",
      projectId: "p1",
      automation: { id: "au1", name: "new-name" },
    } as Parameters<typeof applyAutomationFrame>[0]);
    expect(list.value?.rows[0]?.automation?.name).toBe("new-name");

    applyAutomationFrame({
      type: "automationDeleted",
      projectId: "p1",
      automationId: "au1",
    });
    expect(list.value?.rows[0]?.automation).toBeNull();
  });

  test("an envelope keeps the row's send and last line unless it carries them", async () => {
    const last = { seq: 2, author: "assistant", text: "nine pods" };
    answer = () => Response.json({ rows: [{ ...row(), send: sent, last }] });
    await loadList({ project: null, q: "" });

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, status: "running" }),
      messages: [],
      send: null,
    });
    expect(list.value?.rows[0].send).toEqual(sent);
    expect(list.value?.rows[0].last).toEqual(last);

    const done = { ...sent, status: "done" as const, cause: "finish" as const };
    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 3 }),
      messages: [],
      send: done,
      last: { seq: 4, author: "assistant", text: "all expected" },
    });
    expect(list.value?.rows[0].send).toEqual(done);
    expect(list.value?.rows[0].last?.text).toBe("all expected");
    expect(list.value?.rows[0].session.revision).toBe(3);

    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 2, title: "Old" }),
      messages: [],
      send: null,
      last: { seq: 1, author: "ana", text: "stale" },
    });
    expect(list.value?.rows[0].session.revision).toBe(3);
    expect(list.value?.rows[0].last?.text).toBe("all expected");
  });

  test.serial(
    "a row not held reloads the list, a search too, unless another project filters it",
    async () => {
      const calls: string[] = [];
      answer = (url) => {
        calls.push(url);
        return Response.json({ rows: [] });
      };
      await loadList({ project: null, q: "" });
      onSocket({
        type: "session",
        projectId: "p2",
        session: summary({ id: "s2", projectId: "p2" }),
        messages: [],
        send: sent,
      });
      await settle();
      expect(calls).toEqual(["/api/sessions", "/api/sessions"]);

      await loadList({ project: null, q: "pods" });
      onSocket({
        type: "session",
        projectId: "p1",
        session: summary({ id: "s3", title: "restart pods" }),
        messages: [],
        send: null,
      });
      await loadList({ project: "p1", q: "" });
      onSocket({
        type: "session",
        projectId: "p2",
        session: summary({ id: "s4", projectId: "p2" }),
        messages: [],
        send: null,
      });
      await settle();
      expect(calls).toEqual([
        "/api/sessions",
        "/api/sessions",
        "/api/sessions?q=pods",
        "/api/sessions?q=pods",
        "/api/sessions?project=p1",
      ]);
    },
  );

  test("a list answer in flight keeps a row an envelope moved past it", async () => {
    let release: (r: Response) => void = () => {};
    answer = () => new Promise((r) => (release = r));
    const load = loadList({ project: null, q: "" });
    // nothing is held yet, so the envelope has nothing to update
    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 3, title: "Newer" }),
      messages: [],
      send: null,
    });
    release(Response.json({ rows: [row({ revision: 2, title: "Older" })] }));
    await load;
    expect(list.value?.rows[0].session.title).toBe("Older");

    answer = () => new Promise((r) => (release = r));
    const again = loadList({ project: null, q: "" });
    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ revision: 3, title: "Newer" }),
      messages: [],
      send: null,
    });
    release(Response.json({ rows: [row({ revision: 2, title: "Older" })] }));
    await again;
    expect(list.value?.rows[0].session.title).toBe("Newer");
  });

  test("a revocation drops a list answer in flight", async () => {
    let release: (r: Response) => void = () => {};
    answer = () => new Promise((r) => (release = r));
    const load = loadList({ project: "p2", q: "" });
    onSocket({ type: "revoked", projectId: "p2" });
    release(Response.json({ rows: [row({ id: "s2", projectId: "p2" })] }));
    await load;
    expect(list.value).toBeNull();
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
    list.value = page([row()]);
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
    // a rename is not a send: the composer stays free
    expect(busy).toBe(false);
    expect(sending.value).toBe(false);
    expect(sent).toEqual({ title: "Kept As Typed" });
    expect(session.value?.session.title).toBe("Kept As Typed");
    expect(session.value?.session.revision).toBe(5);
  });

  test.serial(
    "fork posts the turn and the agent, then opens the new chat",
    async () => {
      session.value = detail("s1", {
        messages: [
          message({
            id: "m1",
            kind: "user",
            content: "again?",
            uploads: [
              {
                name: "notes.md",
                archive: false,
                files: 1,
                bytes: 12,
                saved: ["notes.md"],
              },
            ],
          }),
        ],
      });
      path.value = "/chat/s1";
      const rows = new Map<string, string>();
      const realStorage = Object.getOwnPropertyDescriptor(
        globalThis,
        "localStorage",
      );
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => rows.get(key) ?? null,
          setItem: (key: string, value: string) => rows.set(key, value),
          removeItem: (key: string) => rows.delete(key),
        },
      });
      try {
        let hit = "";
        let sent: unknown = null;
        let busy = false;
        let listed = "";
        answer = (url, init) => {
          if (init?.method !== "POST") {
            listed = url;
            return Response.json({ items: [], limits: {} });
          }
          hit = `${init.method} ${url}`;
          sent = JSON.parse(String(init.body));
          busy = forking.value;
          return Response.json({ ...detail("s9"), draftUploads: ["up9"] });
        };
        await forkSession("s1", "m1", "a2");
        expect(hit).toBe("POST /api/sessions/s1/fork");
        expect(sent).toEqual({ messageId: "m1", agentId: "a2" });
        expect(busy).toBe(true);
        expect(forking.value).toBe(false);
        expect(path.value).toBe("/chat/s9");
        // a user message's text is the fork's draft, with the files it
        // carried, staged again, under the names the message knew
        expect(JSON.parse(rows.get(`draft:u${user}:chat:s9`) ?? "{}")).toEqual({
          text: "again?",
          uploads: [{ projectId: "p1", id: "up9", name: "notes.md" }],
        });
        expect(listed).toBe(`/api/projects/p1/uploads`);
      } finally {
        if (realStorage === undefined) {
          Reflect.deleteProperty(globalThis, "localStorage");
        } else {
          Object.defineProperty(globalThis, "localStorage", realStorage);
        }
      }
    },
  );

  test.serial(
    "a fork answered after the person left keeps its draft and moves no page",
    async () => {
      session.value = detail("s1", {
        messages: [message({ id: "m1", kind: "user", content: "again?" })],
      });
      path.value = "/chat/s1";
      const rows = new Map<string, string>();
      const realStorage = Object.getOwnPropertyDescriptor(
        globalThis,
        "localStorage",
      );
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => rows.get(key) ?? null,
          setItem: (key: string, value: string) => rows.set(key, value),
          removeItem: (key: string) => rows.delete(key),
        },
      });
      try {
        let release: (() => void) | null = null;
        answer = (_url, init) =>
          init?.method === "POST"
            ? new Promise<Response>((resolve) => {
                release = () =>
                  resolve(
                    Response.json({ ...detail("s9"), draftUploads: ["up9"] }),
                  );
              })
            : Response.json({ items: [], limits: {} });
        const forked = forkSession("s1", "m1", "a2");
        // the person opens another chat before the fork answers
        session.value = detail("s2");
        path.value = "/chat/s2";
        (release as (() => void) | null)?.();
        await forked;
        expect(path.value).toBe("/chat/s2");
        // the restaged file is not orphaned: it waits in the fork's draft
        expect(
          JSON.parse(rows.get(`draft:u${user}:chat:s9`) ?? "{}").uploads,
        ).toEqual([{ projectId: "p1", id: "up9", name: "a file" }]);
      } finally {
        if (realStorage === undefined) {
          Reflect.deleteProperty(globalThis, "localStorage");
        } else {
          Object.defineProperty(globalThis, "localStorage", realStorage);
        }
      }
    },
  );

  test.serial("leaving a chat for another keeps the next load", async () => {
    const gates: ((value: SessionDetail) => void)[] = [];
    answer = () =>
      new Promise<Response>((resolve) => {
        gates.push((value) => resolve(Response.json(value)));
      });
    const first = loadSession("s1");
    gates[0]!(detail("s1"));
    await first;
    expect(session.value?.session.id).toBe("s1");
    // the next chat's load starts, then the page leaves the first
    const second = loadSession("s2");
    leaveSession("s1");
    gates[1]!(detail("s2"));
    await second;
    expect(session.value?.session.id).toBe("s2");
    // leaving the chat the load is for drops it
    const third = loadSession("s3");
    leaveSession("s3");
    gates[2]!(detail("s3"));
    await third;
    expect(session.value).toBeNull();
  });

  test.serial(
    "a fork refused leaves the page and frees the buttons",
    async () => {
      session.value = detail();
      path.value = "/chat/s1";
      answer = () => Response.json({ error: "not a turn" }, { status: 400 });
      await expect(forkSession("s1", "m1", "a2")).rejects.toThrow();
      expect(forking.value).toBe(false);
      expect(path.value).toBe("/chat/s1");
    },
  );

  test("delete drops the row, leaves the chat and opens its project", async () => {
    session.value = liveDetail();
    list.value = page([row(), row({ id: "s2" })]);
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
    expect(ids(list.value)).toEqual(["s2"]);
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

  test.serial(
    "a deletion off screen loads the project's list again",
    async () => {
      list.value = null;
      const calls: string[] = [];
      answer = (url) => {
        calls.push(url);
        return Response.json({ rows: [row({ id: "s2" })] });
      };
      await loadList({ project: "p1", q: "" });
      onSocket({ type: "deleted", projectId: "p1", sessionId: "s2" });
      await settle();
      expect(calls).toEqual([
        "/api/sessions?project=p1",
        "/api/sessions?project=p1",
      ]);
    },
  );

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

  test.serial(
    "a watched tools phase neither seeds live nor refetches",
    async () => {
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
            toolName: "datetime",
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
    },
  );

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

  test("revoking the project on screen clears its session", async () => {
    session.value = liveDetail();
    path.value = "/chat/s1";
    let release: (r: Response) => void = () => {};
    answer = () => new Promise((r) => (release = r));
    const load = loadSession("s1");

    onSocket({ type: "revoked", projectId: "p1" });

    expect(session.value).toBeNull();
    expect(live.value.size).toBe(0);
    expect(path.value).toBe("/");
    // the answer still in flight for the revoked chat is dropped too
    release(Response.json(liveDetail()));
    await load;
    expect(session.value).toBeNull();
  });

  test("revoking a project drops its rows from the stream", async () => {
    answer = () =>
      Response.json({
        rows: [row({ id: "s1" }), row({ id: "s2", projectId: "p2" })],
      });
    await loadList({ project: null, q: "" });
    onSocket({ type: "revoked", projectId: "p2" });
    expect(ids(list.value)).toEqual(["s1"]);

    await loadList({ project: "p1", q: "" });
    onSocket({ type: "revoked", projectId: "p1" });
    expect(list.value).toBeNull();
  });

  test("drops every session entity when the signed-in user changes", () => {
    session.value = liveDetail();
    sessionError.value = { words: "old", status: 404 };
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
    list.value = page([row()]);
    projectAgents.value = [];
    sending.value = true;

    me.value = {
      id: "another-user",
      username: "ana",
      fullName: "Ana",
      role: "member",
      mustChangePassword: false,
    };

    expect(session.value).toBeNull();
    expect(sessionError.value).toBeNull();
    expect(live.value.size).toBe(0);
    expect(list.value).toBeNull();
    expect(projectAgents.value).toBeNull();
    expect(sending.value).toBe(false);
  });
});

describe("capability flips on a send", () => {
  const bodies: unknown[] = [];
  const take = (status = 200) => {
    bodies.length = 0;
    answer = (url, init) => {
      if (url === "/api/sessions/s1") return Response.json(detail("s1"));
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return status === 200
        ? Response.json(
            detail("s1", { session: summary({ id: "s1", revision: 9 }) }),
          )
        : Response.json({ error: "a send is running" }, { status });
    };
  };
  beforeEach(() => {
    dropFlips(null);
    dropFlips("s1");
  });

  test.serial(
    "a message carries the flips and forgets them once taken",
    async () => {
      take();
      await loadSession("s1");
      flip("s1", [], WEB);
      await sendMessage("s1", "hello", []);
      expect(bodies).toEqual([
        { message: "hello", capabilities: { disable: [WEB] } },
      ]);
      await sendMessage("s1", "again", []);
      expect(bodies[1]).toEqual({ message: "again" });
    },
  );

  test.serial("a refused send keeps the flips for the next try", async () => {
    take(409);
    await loadSession("s1");
    flip("s1", [], WEB);
    await expect(sendMessage("s1", "hello", [])).rejects.toThrow();
    expect(changeOf("s1")).toEqual({ capabilities: { disable: [WEB] } });
    expect(sending.value).toBe(false);
  });

  test.serial(
    "a flip made while the message is on its way is kept",
    async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      answer = async (url) => {
        if (url === "/api/sessions/s1") return Response.json(detail("s1"));
        await gate;
        return Response.json(
          detail("s1", { session: summary({ id: "s1", revision: 9 }) }),
        );
      };
      await loadSession("s1");
      const sending = sendMessage("s1", "hello", []);
      flip("s1", [], WEB);
      release();
      await sending;
      expect(changeOf("s1")).toEqual({ capabilities: { disable: [WEB] } });
    },
  );

  test.serial("regenerate carries them too, compact never", async () => {
    take();
    await loadSession("s1");
    flip("s1", [WEB], WEB);
    await compactSession("s1");
    expect(bodies[0]).toBeUndefined();
    expect(changeOf("s1")).toEqual({ capabilities: { enable: [WEB] } });
    await regenerateSession("s1");
    expect(bodies[1]).toEqual({ capabilities: { enable: [WEB] } });
    expect(changeOf("s1")).toEqual({});
  });

  test.serial(
    "a new chat's first message carries what was flipped before it",
    async () => {
      take();
      flip(null, [], WEB);
      await createSession({ projectId: "p1", agentId: "a1", message: "hi" });
      expect(bodies[0]).toEqual({
        projectId: "p1",
        agentId: "a1",
        message: "hi",
        capabilities: { disable: [WEB] },
      });
      expect(changeOf(null)).toEqual({});
    },
  );

  test.serial(
    "an earlier answer for the project draws while a later one is out",
    async () => {
      const gates: ((name: string) => void)[] = [];
      answer = () =>
        new Promise<Response>((resolve) => {
          gates.push((name) =>
            resolve(
              Response.json({
                agents: [{ id: name, name }],
                capabilities: [],
              }),
            ),
          );
        });
      const first = loadProjectAgents("p1");
      const second = loadProjectAgents("p1");
      gates[0]("older");
      await first;
      expect(projectAgents.value?.map((a) => a.id)).toEqual(["older"]);
      gates[1]("newer");
      await second;
      expect(projectAgents.value?.map((a) => a.id)).toEqual(["newer"]);
    },
  );

  test.serial(
    "an answer for a project no longer picked is dropped",
    async () => {
      const gates: (() => void)[] = [];
      answer = (url) =>
        new Promise<Response>((resolve) => {
          gates.push(() =>
            resolve(
              Response.json({
                agents: [{ id: url.includes("/p1/") ? "a1" : "a2" }],
                capabilities: [],
              }),
            ),
          );
        });
      const first = loadProjectAgents("p1");
      const second = loadProjectAgents("p2");
      gates[0]();
      await first;
      expect(projectAgents.value).toBeNull();
      gates[1]();
      await second;
      expect(projectAgents.value?.map((a) => a.id)).toEqual(["a2"]);
    },
  );

  test.serial("the project's agents answer what can be switched", async () => {
    answer = () => Response.json({ agents: [], capabilities: [WEB] });
    await loadProjectAgents("p1");
    expect(switchable.value).toEqual([WEB]);
    answer = () => Response.json({ agents: [], capabilities: [] });
    await loadProjectAgents("p1");
    expect(switchable.value).toEqual([]);
  });
});

describe("answers held for the way back", () => {
  test.serial(
    "a filter seen before draws its rows at once, and loads again",
    async () => {
      answer = (url) =>
        Response.json({
          rows: url.includes("project=p1") ? [row({ id: "a" })] : [row()],
        });
      await loadList({ project: "p1", q: "" });
      await loadList({ project: null, q: "" });
      let seen: StreamList | null | undefined;
      answer = () => {
        seen = list.value;
        return Response.json({ rows: [row({ id: "a" }), row({ id: "b" })] });
      };
      await loadList({ project: "p1", q: "" });
      expect(ids(seen ?? null)).toEqual(["a"]);
      expect(ids(list.value)).toEqual(["a", "b"]);
    },
  );

  test.serial("a revoked project leaves every held list", async () => {
    answer = (url) =>
      Response.json({
        rows: url.includes("project=p2")
          ? [row({ id: "b", projectId: "p2" })]
          : [row({ id: "a" }), row({ id: "b", projectId: "p2" })],
      });
    await loadList({ project: null, q: "" });
    await loadList({ project: "p2", q: "" });
    await loadList({ project: "p1", q: "" });
    onSocket({ type: "revoked", projectId: "p2" });
    const seen: (StreamList | null)[] = [];
    answer = () => {
      seen.push(list.value);
      return Response.json({ rows: [] });
    };
    await loadList({ project: null, q: "" });
    await loadList({ project: "p2", q: "" });
    expect(seen.map(ids)).toEqual([["a"], undefined]);
  });

  test.serial("a deleted chat leaves every held list", async () => {
    answer = () => Response.json({ rows: [row({ id: "a" }), row()] });
    await loadList({ project: null, q: "" });
    await loadList({ project: "p1", q: "" });
    onSocket({ type: "deleted", sessionId: "a", projectId: "p1" });
    let seen: StreamList | null | undefined;
    answer = () => {
      seen = list.value;
      return Response.json({ rows: [] });
    };
    await loadList({ project: null, q: "" });
    expect(ids(seen ?? null)).toEqual(["s1"]);
  });

  test.serial(
    "a project's agents seen before come back with what they switch",
    async () => {
      answer = (url) =>
        Response.json({
          agents: [],
          capabilities: url.includes("/p1/") ? [WEB] : [],
        });
      await loadProjectAgents("p1");
      await loadProjectAgents("p2");
      expect(switchable.value).toEqual([]);
      let seen: unknown = null;
      answer = () => {
        seen = switchable.value;
        return Response.json({ agents: [], capabilities: [WEB] });
      };
      await loadProjectAgents("p1");
      expect(seen).toEqual([WEB]);
      expect(projectAgents.value).toEqual([]);
    },
  );

  test.serial(
    "a project never seen shows no agents while they load",
    async () => {
      answer = () => Response.json({ agents: [], capabilities: [] });
      await loadProjectAgents("p1");
      let seen: unknown = "unset";
      answer = () => {
        seen = projectAgents.value;
        return Response.json({ agents: [], capabilities: [] });
      };
      await loadProjectAgents("p9");
      expect(seen).toBeNull();
    },
  );

  test.serial("a settled chat seen before is drawn at once", async () => {
    answer = (url) => Response.json(detail(url.endsWith("s1") ? "s1" : "s2"));
    await loadSession("s1");
    await loadSession("s2");
    let seen: string | undefined;
    answer = () => {
      seen = session.value?.session.id;
      return Response.json(
        detail("s1", { session: summary({ id: "s1", title: "Fresh" }) }),
      );
    };
    await loadSession("s1");
    expect(seen).toBe("s1");
    expect(session.value?.session.title).toBe("Fresh");
  });

  test.serial("a running chat is not held", async () => {
    answer = () => Response.json(liveDetail());
    await loadSession("s1");
    answer = () => Response.json(detail("s2"));
    await loadSession("s2");
    let seen: unknown = "unset";
    answer = () => {
      seen = session.value;
      return Response.json(detail("s1"));
    };
    await loadSession("s1");
    expect(seen).toBeNull();
  });

  test.serial(
    "a held chat that moves off screen, fails or is revoked goes",
    async () => {
      answer = (url) => Response.json(detail(url.endsWith("s1") ? "s1" : "s2"));
      await loadSession("s1");
      await loadSession("s2");
      onSocket({
        type: "session",
        projectId: "p1",
        session: summary({ id: "s1", revision: 2 }),
        messages: [],
        send: null,
      });
      let seen: unknown = "unset";
      answer = () => {
        seen = session.value;
        return Response.json({ error: "gone" }, { status: 404 });
      };
      await loadSession("s1");
      expect(seen).toBeNull();
      expect(session.value).toBeNull();

      answer = (url) => Response.json(detail(url.endsWith("s1") ? "s1" : "s2"));
      await loadSession("s1");
      await loadSession("s2");
      onSocket({ type: "revoked", projectId: "p1" });
      seen = "unset";
      answer = () => {
        seen = session.value;
        return Response.json(detail("s1"));
      };
      await loadSession("s1");
      expect(seen).toBeNull();
    },
  );

  test.serial("a new user starts with nothing held", async () => {
    answer = () => Response.json({ rows: [row()] });
    await loadList({ project: "p1", q: "" });
    await loadList({ project: null, q: "" });
    me.value = {
      id: "someone-else",
      username: "ana",
      fullName: "Ana",
      role: "member",
      mustChangePassword: false,
    };
    let seen: unknown = "unset";
    answer = () => {
      seen = list.value;
      return Response.json({ rows: [] });
    };
    await loadList({ project: "p1", q: "" });
    expect(seen).toBeNull();
  });
});

describe("the stream's pages", () => {
  const first = () => [
    row({ id: "a", lastActivityAt: 50 }),
    row({ id: "b", lastActivityAt: 40 }),
  ];
  const second = () => [
    row({ id: "c", lastActivityAt: 30 }),
    row({ id: "d", projectId: "p2", lastActivityAt: 20 }),
  ];

  // Home's chats with two pages held: a b, then c d
  async function twoPages(q = "") {
    const urls: string[] = [];
    answer = (url) => {
      urls.push(url);
      return url.includes("before=")
        ? Response.json({ rows: second(), next: "after-d" })
        : Response.json({ rows: first(), next: "after-b" });
    };
    await loadList({ project: null, q, origin: "chat" });
    await loadMore();
    return urls;
  }

  const arrived = (id: string, title = "Chat") =>
    onSocket({
      type: "session",
      projectId: "p1",
      session: summary({ id, lastActivityAt: 60, title }),
      messages: [],
      send: null,
    });

  const headWith = (id: string) => () =>
    Response.json({
      rows: [row({ id, lastActivityAt: 60 }), first()[0]!],
      next: "after-a",
    });

  test.serial(
    "a later page follows the held rows under the same filter",
    async () => {
      const urls = await twoPages("pods");
      expect(urls).toEqual([
        "/api/sessions?q=pods&origin=chat",
        "/api/sessions?q=pods&origin=chat&before=after-b",
      ]);
      expect(ids(list.value)).toEqual(["a", "b", "c", "d"]);
      expect(list.value?.next).toBe("after-d");
      expect(list.value?.more).toEqual(IDLE);
    },
  );

  test.serial("a page loads once at a time and not past the end", async () => {
    let asked = 0;
    let release: (r: Response) => void = () => {};
    answer = () => Response.json({ rows: first(), next: "after-b" });
    await loadList({ project: null, q: "" });
    answer = () => {
      asked++;
      return new Promise((r) => {
        release = r;
      });
    };
    const more = loadMore();
    expect(list.value?.more.loading).toBe(true);
    void loadMore();
    await settle();
    release(Response.json({ rows: second(), next: null }));
    await more;
    expect(asked).toBe(1);
    await loadMore();
    expect(asked).toBe(1);
    expect(list.value?.next).toBeNull();
  });

  test.serial("a failed page keeps the rows and says why", async () => {
    answer = () => Response.json({ rows: first(), next: "after-b" });
    await loadList({ project: null, q: "" });
    answer = () => Response.json({ error: "busy" }, { status: 503 });
    await loadMore();
    expect(ids(list.value)).toEqual(["a", "b"]);
    expect(list.value?.next).toBe("after-b");
    expect(list.value?.more).toEqual({
      loading: false,
      error: { words: "busy", status: 503 },
    });
    answer = () => Response.json({ rows: second(), next: null });
    await loadMore();
    expect(ids(list.value)).toEqual(["a", "b", "c", "d"]);
    expect(list.value?.more).toEqual(IDLE);
  });

  test.serial("a cold load keeps nothing past the first page", async () => {
    await twoPages();
    // while the socket was down, d was deleted, c renamed and p2
    // revoked; the first page answers as before
    answer = () => Response.json({ rows: first(), next: "after-b" });
    await loadList({ project: null, q: "", origin: "chat" });
    expect(ids(list.value)).toEqual(["a", "b"]);
    expect(list.value?.next).toBe("after-b");
  });

  test.serial("a cold load drops a page in flight", async () => {
    answer = () => Response.json({ rows: first(), next: "after-b" });
    await loadList({ project: null, q: "" });
    let release: (r: Response) => void = () => {};
    answer = () =>
      new Promise((r) => {
        release = r;
      });
    const more = loadMore();
    await settle();
    answer = () => Response.json({ rows: first(), next: "after-b" });
    await loadList({ project: null, q: "" });
    expect(list.value?.more).toEqual(IDLE);
    release(Response.json({ rows: second(), next: null }));
    await more;
    expect(ids(list.value)).toEqual(["a", "b"]);
    expect(list.value?.next).toBe("after-b");
  });

  test.serial(
    "a search's envelope for a row not held refreshes warm, keeping the tail",
    async () => {
      const urls = await twoPages("pods");
      const head = headWith("n");
      answer = (url) => {
        urls.push(url);
        return head();
      };
      arrived("n", "restart the Pods");
      await settle();
      expect(urls.at(-1)).toBe("/api/sessions?q=pods&origin=chat");
      expect(ids(list.value)).toEqual(["n", "a", "b", "c", "d"]);
      expect(list.value?.next).toBe("after-d");
    },
  );

  test.serial(
    "a search asks nothing for an envelope whose title is not in it",
    async () => {
      const urls = await twoPages("pods");
      const asked = urls.length;
      arrived("n", "disk usage");
      await settle();
      arrived("n", "disk usage");
      await settle();
      expect(urls.length).toBe(asked);
      expect(ids(list.value)).toEqual(["a", "b", "c", "d"]);
    },
  );

  test.serial(
    "a page read before a delete does not bring it back",
    async () => {
      answer = () => Response.json({ rows: first(), next: "after-b" });
      await loadList({ project: null, q: "" });
      let release: (r: Response) => void = () => {};
      answer = () =>
        new Promise((r) => {
          release = r;
        });
      const more = loadMore();
      await settle();
      answer = () => Response.json({ rows: first(), next: "after-b" });
      onSocket({ type: "deleted", sessionId: "c", projectId: "p1" });
      await settle();
      release(Response.json({ rows: second(), next: null }));
      await more;
      expect(ids(list.value)).toEqual(["a", "b"]);
      expect(list.value?.next).toBe("after-b");
      expect(list.value?.more).toEqual(IDLE);
    },
  );

  test.serial("a grant while the first page loads asks again", async () => {
    const urls: string[] = [];
    let release: (r: Response) => void = () => {};
    answer = (url) => {
      urls.push(url);
      return new Promise((r) => {
        release = r;
      });
    };
    const stale = loadList({ project: null, q: "" });
    await settle();
    const first0 = release;
    answer = (url) => {
      urls.push(url);
      return Response.json({ rows: first(), next: "after-b" });
    };
    onSocket({ type: "granted", projectId: "p3" });
    await settle();
    first0(Response.json({ rows: [], next: null }));
    await stale;
    expect(urls).toEqual(["/api/sessions", "/api/sessions"]);
    expect(ids(list.value)).toEqual(["a", "b"]);
  });

  test.serial("a page read before a rename carries the new name", async () => {
    const run = (id: string, at: number): StreamRow => ({
      ...row({
        id,
        lastActivityAt: at,
        origin: "automation",
        automationId: "t1",
      }),
      automation: { id: "t1", name: "old-name" },
    });
    answer = () => Response.json({ rows: [run("a", 50)], next: "after-a" });
    await loadList({ project: null, q: "" });
    let release: (r: Response) => void = () => {};
    answer = () =>
      new Promise((r) => {
        release = r;
      });
    const more = loadMore();
    await settle();
    applyAutomationFrame({
      type: "automation",
      projectId: "p1",
      automation: { id: "t1", name: "new-name" },
    } as Parameters<typeof applyAutomationFrame>[0]);
    release(Response.json({ rows: [run("b", 40)], next: null }));
    await more;
    expect(list.value?.rows.map((r) => r.automation?.name)).toEqual([
      "new-name",
      "new-name",
    ]);
  });

  test.serial(
    "a search holds a title as SQLite does, ASCII folded only",
    async () => {
      const urls = await twoPages("\u03a3");
      const asked = urls.length;
      answer = (url) => {
        urls.push(url);
        return Response.json({ rows: first(), next: "after-b" });
      };
      // JavaScript lowercases this title's sigma to its final form
      arrived("n", "A\u03a3");
      await settle();
      expect(urls.length).toBe(asked + 1);
    },
  );

  test.serial(
    "a revocation of another project leaves a project's load alone",
    async () => {
      let release: (r: Response) => void = () => {};
      answer = () =>
        new Promise((r) => {
          release = r;
        });
      const load = loadList({ project: "p1", q: "" });
      await settle();
      onSocket({ type: "revoked", projectId: "p2" });
      release(Response.json({ rows: first(), next: null }));
      await load;
      expect(ids(list.value)).toEqual(["a", "b"]);
    },
  );

  test.serial(
    "a delete in a project not listed leaves a page in flight",
    async () => {
      answer = () => Response.json({ rows: first(), next: "after-b" });
      await loadList({ project: "p1", q: "" });
      let release: (r: Response) => void = () => {};
      answer = () =>
        new Promise((r) => {
          release = r;
        });
      const more = loadMore();
      await settle();
      onSocket({ type: "deleted", sessionId: "z", projectId: "p9" });
      release(Response.json({ rows: second(), next: null }));
      await more;
      expect(ids(list.value)).toEqual(["a", "b", "c", "d"]);
    },
  );

  test.serial(
    "a rename is kept only over answers asked before it",
    async () => {
      const run = (id: string, at: number, name: string): StreamRow => ({
        ...row({
          id,
          lastActivityAt: at,
          origin: "automation",
          automationId: "t1",
        }),
        automation: { id: "t1", name },
      });
      answer = () =>
        Response.json({ rows: [run("a", 50, "old-name")], next: null });
      await loadList({ project: null, q: "" });
      applyAutomationFrame({
        type: "automation",
        projectId: "p1",
        automation: { id: "t1", name: "b-name" },
      } as Parameters<typeof applyAutomationFrame>[0]);
      // renamed again while the socket was down; the reload says so
      answer = () =>
        Response.json({ rows: [run("a", 50, "c-name")], next: null });
      await loadList({ project: null, q: "" });
      expect(list.value?.rows[0]?.automation?.name).toBe("c-name");
    },
  );

  test.serial("a warm refresh leaves a page in flight to land", async () => {
    answer = () => Response.json({ rows: first(), next: "after-b" });
    await loadList({ project: null, q: "" });
    let release: (r: Response) => void = () => {};
    answer = () =>
      new Promise((r) => {
        release = r;
      });
    const more = loadMore();
    await settle();
    answer = headWith("n");
    arrived("n");
    await settle();
    expect(list.value?.more.loading).toBe(true);
    release(Response.json({ rows: second(), next: null }));
    await more;
    expect(ids(list.value)).toEqual(["n", "a", "b", "c", "d"]);
    expect(list.value?.next).toBeNull();
  });

  test.serial(
    "a refresh asked while a cold load is out is cold too",
    async () => {
      await twoPages();
      let release: (r: Response) => void = () => {};
      answer = () =>
        new Promise((r) => {
          release = r;
        });
      const cold = loadList({ project: null, q: "", origin: "chat" });
      await settle();
      answer = () => Response.json({ rows: first(), next: "after-b" });
      arrived("n");
      await settle();
      release(Response.json({ rows: first(), next: "after-b" }));
      await cold;
      expect(ids(list.value)).toEqual(["a", "b"]);
    },
  );

  test.serial("a held filter comes back with its first page", async () => {
    await twoPages();
    answer = () => Response.json({ rows: [], next: null });
    await loadList({ project: "p1", q: "" });
    let seen: StreamList | null | undefined;
    answer = () => {
      seen = list.value;
      return Response.json({ rows: first(), next: "after-b" });
    };
    await loadList({ project: null, q: "", origin: "chat" });
    expect(ids(seen)).toEqual(["a", "b"]);
    expect(seen?.next).toBe("after-b");
    expect(ids(list.value)).toEqual(["a", "b"]);
  });

  test.serial("a revocation loads Home cold", async () => {
    await twoPages();
    answer = () => Response.json({ rows: first(), next: "after-b" });
    onSocket({ type: "revoked", projectId: "p3" });
    await settle();
    expect(ids(list.value)).toEqual(["a", "b"]);
  });

  test.serial("a granted project loads Home again", async () => {
    const urls = await twoPages();
    answer = (url) => {
      urls.push(url);
      return Response.json({ rows: first(), next: "after-b" });
    };
    onSocket({ type: "granted", projectId: "p3" });
    await settle();
    expect(urls.at(-1)).toBe("/api/sessions?origin=chat");
    expect(ids(list.value)).toEqual(["a", "b"]);
  });
});

describe("runs grouped in All", () => {
  // the line of automation au in All, its run at a time, counting runs
  const line = (
    id: string,
    at: number,
    runs: number,
    changes: Partial<SessionSummary> = {},
  ): StreamRow => ({
    ...row({
      id,
      origin: "automation",
      automationId: "au",
      title: "digest",
      createdAt: at,
      lastActivityAt: at,
      ...changes,
    }),
    automation: { id: "au", name: "digest" },
    runs,
  });
  const run = (id: string, at: number, changes: Partial<SessionSummary> = {}) =>
    onSocket({
      type: "session",
      projectId: "p1",
      session: line(id, at, 0, changes).session,
      messages: [],
      send: null,
    });

  test.serial("a new run takes its line and counts up", async () => {
    answer = () =>
      Response.json({ rows: [row({ id: "c1" }), line("r1", 5, 3)] });
    await loadList({ project: null, q: "" });
    answer = (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    };
    run("r2", 90, { status: "running" });
    expect(ids(list.value)).toEqual(["r2", "c1"]);
    expect(list.value?.rows[0]?.runs).toBe(4);
    run("r2", 95, { revision: 2 });
    expect(ids(list.value)).toEqual(["r2", "c1"]);
    expect(list.value?.rows[0]?.runs).toBe(4);
    expect(list.value?.rows[0]?.session.status).toBe("done");
  });

  test.serial("a run of an automation with no line loads again", async () => {
    const urls: string[] = [];
    answer = (url) => {
      urls.push(url);
      return Response.json({ rows: [row({ id: "c1" })] });
    };
    await loadList({ project: null, q: "" });
    run("r1", 90);
    await settle();
    expect(urls).toEqual(["/api/sessions", "/api/sessions"]);
  });

  test.serial(
    "under a search a run that misses it leaves the line",
    async () => {
      answer = () => Response.json({ rows: [line("r1", 5, 3)] });
      await loadList({ project: null, q: "digest" });
      answer = (url) => {
        throw new Error(`unexpected fetch: ${url}`);
      };
      run("r2", 90, { title: "renamed" });
      expect(ids(list.value)).toEqual(["r1"]);
      expect(list.value?.rows[0]?.runs).toBe(3);
    },
  );

  test.serial("Tasks lists every run on its own", async () => {
    const urls: string[] = [];
    answer = (url) => {
      urls.push(url);
      return Response.json({ rows: [{ ...line("r1", 5, 0), runs: null }] });
    };
    await loadList({ project: null, q: "", origin: "automation" });
    run("r2", 90);
    await settle();
    expect(urls).toHaveLength(2);
  });

  test.serial(
    "a deleted automation's line stops counting and loads again",
    async () => {
      const urls: string[] = [];
      answer = (url) => {
        urls.push(url);
        return Response.json({
          rows:
            urls.length === 1
              ? [line("r2", 9, 2)]
              : [
                  { ...line("r2", 9, 0, { automationId: null }), runs: null },
                  { ...line("r1", 5, 0, { automationId: null }), runs: null },
                ],
        });
      };
      await loadList({ project: null, q: "" });
      applyAutomationFrame({
        type: "automationDeleted",
        projectId: "p1",
        automationId: "au",
      });
      expect(list.value?.rows[0]?.runs).toBeNull();
      await settle();
      expect(urls).toHaveLength(2);
      expect(ids(list.value)).toEqual(["r2", "r1"]);
    },
  );

  test.serial("a first page asked before a swap keeps the swap", async () => {
    let release: (r: Response) => void = () => {};
    answer = () =>
      new Promise((r) => {
        release = r;
      });
    const loading = loadList({ project: null, q: "" });
    await settle();
    // no list held yet: the envelope asks again, so hold one first
    release(Response.json({ rows: [line("r1", 5, 3), row({ id: "c1" })] }));
    await loading;
    answer = () =>
      new Promise((r) => {
        release = r;
      });
    const again = loadList({ project: null, q: "" });
    await settle();
    run("r2", 90, { status: "running" });
    expect(ids(list.value)).toEqual(["r2", "c1"]);
    release(Response.json({ rows: [line("r1", 5, 3), row({ id: "c1" })] }));
    await again;
    expect(ids(list.value)).toEqual(["r2", "c1"]);
    expect(list.value?.rows[0]?.runs).toBe(4);
  });

  test.serial(
    "a delete during the first load asks for the page again",
    async () => {
      const urls: string[] = [];
      let release: (r: Response) => void = () => {};
      answer = (url) => {
        urls.push(url);
        if (urls.length === 1) {
          return new Promise((r) => {
            release = r;
          });
        }
        return Response.json({
          rows: [{ ...line("r1", 5, 0, { automationId: null }), runs: null }],
        });
      };
      const first = loadList({ project: null, q: "" });
      await settle();
      applyAutomationFrame({
        type: "automationDeleted",
        projectId: "p1",
        automationId: "au",
      });
      release(Response.json({ rows: [line("r1", 5, 2)] }));
      await first;
      await settle();
      expect(urls).toHaveLength(2);
      expect(list.value?.rows[0]?.runs).toBeNull();
    },
  );

  test.serial("a run moved during the first load asks once more", async () => {
    const urls: string[] = [];
    let release: (r: Response) => void = () => {};
    answer = (url) => {
      urls.push(url);
      if (urls.length === 1) {
        return new Promise((r) => {
          release = r;
        });
      }
      return Response.json({ rows: [line("r2", 90, 4)] });
    };
    const first = loadList({ project: null, q: "" });
    await settle();
    run("r2", 90, { status: "running" });
    run("r2", 91, { revision: 2, status: "running" });
    release(Response.json({ rows: [line("r1", 5, 3)] }));
    await first;
    await settle();
    expect(urls).toHaveLength(2);
    expect(ids(list.value)).toEqual(["r2"]);
    expect(list.value?.rows[0]?.runs).toBe(4);
  });
});
