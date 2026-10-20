// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The channel on screen: older pages land above, a reload keeps them,
// a quote of a post above the pages reads its window, the gap fills,
// each running turn keeps its own retry, the turn actions name their
// send or pending turn, and a gone subagent is not asked for again.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { path, query } from "../../../src/client/app/router.ts";
import {
  cancelTurn,
  channelGap,
  focusPost,
  loadGap,
  loadOlder,
  olderPage,
  showPost,
  stopTurn,
} from "../../../src/client/data/channel.ts";
import {
  fillGap,
  inView,
  mergeAround,
  mergeNewest,
  mergeOlder,
} from "../../../src/client/data/channel-pages.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  childWork,
  loadChild,
} from "../../../src/client/data/session-children.ts";
import {
  leaveSession,
  loadSession,
  onSocket,
  retries,
  session,
} from "../../../src/client/data/sessions.ts";
import type {
  LiveSend,
  Message,
  SendSummary,
  SessionDetail,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";

const channelSummary = (changes: Partial<SessionSummary> = {}) =>
  ({
    archived: null,
    attention: null,
    attentionReason: null,
    attentionSource: null,
    attentionBy: null,
    id: "c1",
    projectId: "p1",
    ownerId: null,
    agentId: null,
    origin: "channel",
    droppedSeq: null,
    automationId: null,
    runSource: null,
    forkedFromId: null,
    title: "finops",
    status: "done",
    revision: 1,
    createdAt: 1,
    lastActivityAt: 1,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  }) satisfies SessionSummary;

function row(changes: Partial<Message> & Pick<Message, "id" | "seq">): Message {
  return {
    sessionId: "c1",
    kind: "reply",
    sendId: "s",
    round: 1,
    slot: "answer",
    userId: null,
    agentId: "a1",
    content: "",
    resultBytes: null,
    uploads: null,
    files: null,
    saved: null,
    promptTokens: null,
    reasoning: "",
    html: "",
    status: "done",
    error: null,
    finishReason: "stop",
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: "m",
    ttftMs: null,
    thinkingMs: null,
    upstream: null,
    servedModel: null,
    nativeFinish: null,
    createdAt: 1,
    finishedAt: 2,
    ...changes,
  };
}

// a post at seq, its own post send
const post = (seq: number, text = `post ${seq}`): Message =>
  row({
    id: `p${seq}`,
    seq,
    kind: "user",
    sendId: `post-${seq}`,
    slot: null,
    userId: "u1",
    agentId: null,
    content: text,
    finishReason: null,
    model: null,
  });

const turnOf = (
  id: string,
  postSeq: number,
  changes: Partial<SendSummary> = {},
): SendSummary => ({
  id,
  sessionId: "c1",
  kind: "chat",
  userId: "u1",
  agentId: "a1",
  providerId: "pr1",
  model: "m",
  status: "done",
  cause: null,
  error: null,
  firstMessageId: `p${postSeq}`,
  rounds: 1,
  toolCalls: 0,
  memoryRound: null,
  attentionRound: null,
  memoryFrom: null,
  memoryError: null,
  memorySkipped: null,
  summoned: true,
  tokens: 0,
  startedAt: 1,
  finishedAt: 2,
  ...changes,
});

const answerOf = (sendId: string, seq: number, changes = {}) =>
  row({ id: `r${seq}`, seq, sendId, content: `answer ${seq}`, ...changes });

function page(
  messages: Message[],
  before: number | null,
  changes: Partial<SessionDetail> = {},
): SessionDetail {
  return {
    session: channelSummary(),
    forkedFrom: null,
    messages,
    page: { before, after: null },
    send: null,
    sends: [],
    live: [],
    pending: [],
    authors: [],
    agents: [],
    archive: null,
    queued: [],
    automationDrafts: [],
    ...changes,
  };
}

const ids = () => session.value?.messages.map((m) => m.id);

const realFetch = globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
let asked: { url: string; method: string }[] = [];
let answer: (url: string) => Response | Promise<Response>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://test.invalid", pathname: "/", search: "" },
  });
  path.value = "/";
  query.value = "";
  asked = [];
  answer = (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, method: init?.method ?? "GET" });
    return answer(url);
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  leaveSession();
  me.value = undefined;
  await settle();
  globalThis.fetch = realFetch;
  if (realLocation === undefined)
    Reflect.deleteProperty(globalThis, "location");
  else Object.defineProperty(globalThis, "location", realLocation);
});

// the newest page held and its watch answered
async function open(detail: SessionDetail): Promise<void> {
  answer = () => Response.json(detail);
  await loadSession("c1");
  onSocket({ type: "watched", sessionId: "c1", live: detail.live });
}

describe("the channel's pages", () => {
  test.serial("an older page lands above and takes its cursor", async () => {
    await open(
      page([post(30), answerOf("t30", 31), post(40)], 30, {
        sends: [turnOf("t30", 30)],
      }),
    );
    answer = (url) => {
      expect(url).toBe("/api/sessions/c1?before=30");
      return Response.json(
        page([post(10), post(20), answerOf("t20", 21)], null, {
          sends: [turnOf("t20", 20)],
        }),
      );
    };
    await loadOlder();
    expect(ids()).toEqual(["p10", "p20", "r21", "p30", "r31", "p40"]);
    expect(session.value?.page?.before).toBeNull();
    expect(session.value?.sends?.map((s) => s.id)).toEqual(["t30", "t20"]);
    expect(olderPage.value).toEqual({ loading: false, failure: null });
  });

  test.serial("a failed older page says why and keeps the rows", async () => {
    await open(page([post(30)], 30));
    answer = () =>
      Response.json({ error: "the server broke" }, { status: 500 });
    await loadOlder();
    expect(olderPage.value.failure).toBe("The server broke.");
    expect(ids()).toEqual(["p30"]);
  });

  test.serial(
    "a stream gap reloads the newest page and keeps the older ones",
    async () => {
      await open(page([post(30), post(40)], 30));
      answer = () => Response.json(page([post(10), post(20)], null));
      await loadOlder();
      // a frame past its send's sequence is a gap: the detail is read again
      answer = (url) => {
        expect(url).toBe("/api/sessions/c1");
        return Response.json(
          page([post(30), post(40), post(50)], 30, {
            session: channelSummary({ revision: 3 }),
          }),
        );
      };
      onSocket({
        type: "delta",
        sessionId: "c1",
        sendId: "t50",
        messageId: "r51",
        seq: 4,
        content: "x",
        reasoning: "",
      } as never);
      await settle();
      await settle();
      expect(asked.at(-1)?.url).toBe("/api/sessions/c1");
      expect(ids()).toEqual(["p10", "p20", "p30", "p40", "p50"]);
      expect(session.value?.page?.before).toBeNull();
      expect(channelGap.value).toBeNull();
    },
  );

  test("a newest page that shares no row leaves a gap above it", () => {
    const held = page([post(10), post(20)], 10);
    const fresh = page([post(80), post(90)], 80);
    const merged = mergeNewest(held, fresh, null);
    expect(merged.detail.messages.map((m) => m.id)).toEqual([
      "p10",
      "p20",
      "p80",
      "p90",
    ]);
    expect(merged.detail.page?.before).toBe(10);
    expect(merged.gap).toEqual({ after: 20, before: 80 });
    // a newest page that holds every turn is taken whole
    expect(mergeNewest(held, page([post(90)], null), null).detail).toEqual(
      page([post(90)], null),
    );
  });

  test("a reload replaces a turn's rows and drops the window", () => {
    const held = page(
      [post(5), post(30), answerOf("t30", 31, { status: "streaming" })],
      30,
      { sends: [turnOf("t30", 30, { status: "running" })] },
    );
    const fresh = page([post(30), answerOf("t30", 31)], 30, {
      sends: [turnOf("t30", 30)],
    });
    const merged = mergeNewest(held, fresh, { after: 5, before: 30 });
    expect(merged.detail.messages.map((m) => [m.id, m.status])).toEqual([
      ["p30", "done"],
      ["r31", "done"],
    ]);
    expect(merged.detail.sends?.map((s) => s.status)).toEqual(["done"]);
    expect(merged.gap).toBeNull();
  });

  test("an older page and a window merge by cursor", () => {
    const held = page([post(50)], 50);
    expect(mergeOlder(held, page([post(40)], 40)).page?.before).toBe(40);
    const window = { ...page([post(10), post(20)], 10) };
    window.page = { before: 10, after: 20 };
    const around = mergeAround(held, window, null);
    expect(around.gap).toEqual({ after: 20, before: 50 });
    expect(around.detail.page?.before).toBe(10);
    // a window that reaches the pages joins them
    const near = { ...page([post(40)], 30), page: { before: 30, after: 50 } };
    expect(mergeAround(held, near, null).gap).toBeNull();
    // filling: around the window's last post until it reaches the pages
    const next = { ...page([post(30)], 20), page: { before: 20, after: 30 } };
    expect(fillGap(around.detail, next, around.gap!).gap).toEqual({
      after: 30,
      before: 50,
    });
    const last = { ...page([post(40)], 20), page: { before: 20, after: null } };
    expect(fillGap(around.detail, last, around.gap!).gap).toBeNull();
  });

  test("a post above the pages or in the gap is not in view", () => {
    expect(inView(10, null, null)).toBe(true);
    expect(inView(10, 20, null)).toBe(false);
    expect(inView(20, 20, null)).toBe(true);
    const gap = { after: 30, before: 60 };
    expect(inView(30, 10, gap)).toBe(true);
    expect(inView(40, 10, gap)).toBe(false);
    expect(inView(60, 10, gap)).toBe(true);
  });
});

describe("a quote's post", () => {
  test.serial("a held post is scrolled to with no read", async () => {
    await open(page([post(30), answerOf("t30", 31)], null));
    await showPost({ id: "p30", seq: 30 });
    expect(focusPost.value).toBe("p30");
    expect(asked.filter((a) => a.url.includes("around"))).toEqual([]);
  });

  test.serial(
    "a post above the pages reads its window, then the gap fills",
    async () => {
      await open(page([post(50), answerOf("t50", 51)], 50));
      answer = (url) => {
        expect(url).toBe("/api/sessions/c1?around=10");
        return Response.json({
          ...page([post(10), post(20)], null),
          page: { before: null, after: 20 },
        });
      };
      await showPost({ id: "p10", seq: 10 });
      expect(ids()).toEqual(["p10", "p20", "p50", "r51"]);
      expect(channelGap.value).toEqual({ after: 20, before: 50 });
      expect(session.value?.page?.before).toBeNull();
      expect(focusPost.value).toBe("p10");
      answer = (url) => {
        expect(url).toBe("/api/sessions/c1?around=20");
        return Response.json({
          ...page([post(20), post(30), post(40)], null),
          page: { before: 10, after: null },
        });
      };
      await loadGap();
      expect(ids()).toEqual(["p10", "p20", "p30", "p40", "p50", "r51"]);
      expect(channelGap.value).toBeNull();
    },
  );
});

describe("a quote's failed read", () => {
  test.serial("leaves the page as it was", async () => {
    await open(page([post(50)], 50));
    answer = () => Response.json({ error: "down" }, { status: 503 });
    await showPost({ id: "p10", seq: 10 });
    expect(ids()).toEqual(["p50"]);
    expect(focusPost.value).toBeNull();
    expect(channelGap.value).toBeNull();
  });
});

describe("turns side by side", () => {
  const tail = (sendId: string, messageId: string, extra = {}): LiveSend => ({
    phase: "reply",
    sendId,
    messageId,
    seq: 1,
    content: "",
    reasoning: "",
    html: "",
    htmlAt: 0,
    ...extra,
  });
  const running = () =>
    page(
      [
        post(10),
        post(20),
        answerOf("tA", 11, { status: "streaming", slot: null }),
        answerOf("tB", 21, { status: "streaming", slot: null }),
      ],
      null,
      {
        session: channelSummary({ status: "running" }),
        sends: [
          turnOf("tA", 10, { status: "running" }),
          turnOf("tB", 20, { status: "running", userId: "u2" }),
        ],
        live: [
          tail("tA", "r11"),
          tail("tB", "r21", { retry: { attempt: 1, max: 3 } }),
        ],
      },
    );

  test.serial("a retry marks only its own turn", async () => {
    await open(running());
    expect([...retries.value]).toEqual([["tB", { attempt: 1, max: 3 }]]);
    onSocket({
      type: "retry",
      sessionId: "c1",
      sendId: "tA",
      seq: 2,
      retry: { attempt: 2, max: 3 },
    });
    expect(retries.value.get("tA")).toEqual({ attempt: 2, max: 3 });
    expect(retries.value.get("tB")).toEqual({ attempt: 1, max: 3 });
    // one turn ends while the channel runs on: only its retry goes
    onSocket({
      type: "session",
      row: null,
      projectId: "p1",
      session: channelSummary({ status: "running", revision: 2 }),
      messages: [answerOf("tA", 11)],
      send: turnOf("tA", 10),
    });
    expect(retries.value.has("tA")).toBe(false);
    expect(retries.value.get("tB")).toEqual({ attempt: 1, max: 3 });
    expect(session.value?.sends?.find((s) => s.id === "tA")?.status).toBe(
      "done",
    );
    expect(session.value?.live.map((l) => l.sendId)).toEqual(["tB"]);
  });

  test.serial("an envelope's post send is no turn", async () => {
    await open(page([post(10)], null));
    onSocket({
      type: "session",
      row: null,
      projectId: "p1",
      session: channelSummary({ revision: 2 }),
      messages: [post(20)],
      send: turnOf("post-20", 20, { kind: "post", agentId: null }),
    });
    expect(session.value?.sends).toEqual([]);
    expect(session.value?.send?.id).toBe("post-20");
  });

  test.serial(
    "a live tail on a post above the pages is not read again",
    async () => {
      await open(page([post(50)], 50, { session: channelSummary() }));
      const before = asked.length;
      // the watch repeated on a socket open, with a tail the rows lack
      answer = () => Response.json(page([post(50)], 50));
      await loadSession("c1");
      onSocket({
        type: "watched",
        sessionId: "c1",
        live: [tail("tOld", "r99")],
      });
      await settle();
      expect(asked.length).toBe(before + 1);
    },
  );

  test.serial("stop names the send and cancel the pending turn", async () => {
    answer = () => Response.json({});
    await stopTurn("c1", "tB");
    await cancelTurn("c1", "w1");
    expect(asked).toEqual([
      { url: "/api/sessions/c1/sends/tB/stop", method: "POST" },
      { url: "/api/sessions/c1/pending/w1", method: "DELETE" },
    ]);
  });
});

describe("a gone subagent", () => {
  test.serial("a 404 marks it gone and it is not read again", async () => {
    await open(page([post(10)], null));
    answer = () =>
      Response.json({ error: "no such subagent" }, { status: 404 });
    await loadChild("d1", true);
    expect(childWork.value.get("d1")).toEqual({
      loading: false,
      error: null,
      work: null,
      gone: true,
    });
    const before = asked.length;
    await loadChild("d1", true);
    expect(asked.length).toBe(before);
  });
});
