// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A channel has no agent of its own, so the agents its live turns name
// come from the project's list, which its page loads as a chat's does:
// a turn an envelope adds, a pending turn and a refused one all draw
// their agent's name. A chat is drawn as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path, query } from "../../../src/client/app/router.ts";
import { match } from "../../../src/client/app/routes.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  leaveSession,
  onSocket,
  projectAgents,
} from "../../../src/client/data/sessions.ts";
import { Chat } from "../../../src/client/views/sessions/Chat.tsx";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type {
  Message,
  SendSummary,
  SessionDetail,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";

const agent = (id: string, name: string): AgentSummary => ({
  id,
  name,
  avatar: "bot",
  providerId: "pr1",
  model: {
    id: "acme/small",
    name: "Small",
    contextLength: 262_144,
    promptPrice: null,
    completionPrice: null,
    tools: true,
    reasoning: false,
    thinkingRequired: false,
    reasoningKnown: true,
    described: true,
    images: null,
  },
  thinking: null,
  effort: null,
  prompt: "",
  skills: [],
  servers: [],
  mcpMode: "auto",
  upstream: null,
  skip4Bit: false,
  subagents: false,
  images: false,
  default: id === "a1",
  createdAt: 0,
});

const summary = (changes: Partial<SessionSummary>): SessionSummary => ({
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
});

function row(changes: Partial<Message> & Pick<Message, "id" | "seq">): Message {
  return {
    sessionId: "c1",
    kind: "user",
    sendId: `post-${changes.seq}`,
    round: 1,
    slot: null,
    userId: "u1",
    agentId: null,
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
    finishReason: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    model: null,
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

const send = (changes: Partial<SendSummary>): SendSummary => ({
  id: "t1",
  sessionId: "c1",
  kind: "chat",
  userId: "u1",
  agentId: "a2",
  providerId: "pr1",
  model: "acme/small",
  status: "running",
  cause: null,
  error: null,
  firstMessageId: "p1",
  rounds: 1,
  toolCalls: 0,
  memoryRound: null,
  attentionRound: null,
  memoryFrom: null,
  memoryError: null,
  memorySkipped: null,
  summoned: true,
  tokens: 0,
  cost: null,
  startedAt: 1,
  finishedAt: null,
  ...changes,
});

const detail = (changes: Partial<SessionDetail>): SessionDetail => ({
  session: summary({}),
  forkedFrom: null,
  messages: [],
  send: null,
  sends: [],
  live: [],
  authors: [],
  // a fresh read names only the agents its rows do: none yet
  agents: [],
  archive: null,
  queued: [],
  automationDrafts: [],
  ...changes,
});

const realFetch = globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
let asked: string[] = [];
let shown: SessionDetail;

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
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    if (url === `/api/sessions/${shown.session.id}`) {
      return Response.json(shown);
    }
    if (url === "/api/projects/p1/agents") {
      return Response.json({
        agents: [agent("a1", "coder"), agent("a2", "reviewer")],
        startsOn: "a1",
        capabilities: [],
        servers: {},
        skills: {},
        credentials: [],
        repos: [],
      });
    }
    return Response.json({ error: "not here" }, { status: 500 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  leaveSession();
  me.value = undefined;
  projectAgents.value = null;
  globalThis.fetch = realFetch;
  if (realLocation === undefined) {
    Reflect.deleteProperty(globalThis, "location");
  } else Object.defineProperty(globalThis, "location", realLocation);
});

// the page's own load, as a navigation runs it
async function visit(id: string): Promise<void> {
  const m = match(`/chat/${id}`)!;
  await m.route.load!(m.params, new URLSearchParams());
  onSocket({ type: "watched", sessionId: id, live: [] });
}

describe("a channel's live turns", () => {
  test.serial("name their agents from the project's list", async () => {
    shown = detail({ messages: [row({ id: "p1", seq: 1, content: "go" })] });
    await visit("c1");
    expect(asked).toContain("/api/projects/p1/agents");
    // a summoned turn arrives by envelope
    onSocket({
      type: "session",
      row: null,
      projectId: "p1",
      session: summary({ status: "running", revision: 2 }),
      messages: [
        row({
          id: "r2",
          seq: 2,
          kind: "reply",
          sendId: "t1",
          userId: null,
          agentId: "a2",
          status: "streaming",
        }),
      ],
      send: send({}),
    });
    // a pending turn, and one refused at its start
    onSocket({
      type: "queue",
      sessionId: "c1",
      revision: 3,
      turn: false,
      rows: [],
      pending: [
        {
          id: "w1",
          messageId: "p1",
          authorId: "u1",
          agentId: "a1",
          queuedAt: 1,
          reason: null,
        },
        {
          id: "w2",
          messageId: "p1",
          authorId: "u1",
          agentId: "a2",
          queuedAt: 1,
          reason: "failed",
        },
      ],
    });
    const html = render(<Chat params={{ id: "c1" }} />);
    expect(html).toContain(">reviewer</a>");
    expect(html).toContain("Waiting for @coder");
    expect(html).toContain("@reviewer did not start");
    expect(html).not.toContain("@agent");
    expect(html).not.toContain('class="transcript-name">agent<');
  });
});

describe("a chat", () => {
  test.serial("names its own agent as before", async () => {
    shown = detail({
      session: summary({
        id: "s1",
        origin: "chat",
        ownerId: "u1",
        agentId: "a1",
        title: "Chat",
      }),
      messages: [
        row({ id: "m1", seq: 1, sessionId: "s1", sendId: "x1", content: "hi" }),
        row({
          id: "m2",
          seq: 2,
          sessionId: "s1",
          kind: "reply",
          sendId: "x1",
          slot: "answer",
          userId: null,
          agentId: "a1",
          content: "hello",
          html: "<p>hello</p>",
        }),
      ],
    });
    await visit("s1");
    expect(asked).toContain("/api/projects/p1/agents");
    const html = render(<Chat params={{ id: "s1" }} />);
    expect(html).toContain(">coder</a>");
    expect(html).not.toContain("channel-");
  });
});
