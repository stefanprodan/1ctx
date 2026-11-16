// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat waits as a chat: while its session loads the page draws three
// turns and a composer-shaped foot in bones, one status named for the
// chat, and never mounts the real composer. A settled chat opened again
// draws at once from the copy kept of it, with no bones. The route's
// fallback while the view's code loads is the same shape.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path, query } from "../../../src/client/app/router.ts";
import { match } from "../../../src/client/app/routes.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  leaveSession,
  loadSession,
  onSocket,
  projectAgents,
} from "../../../src/client/data/sessions.ts";
import { Chat, Run } from "../../../src/client/views/sessions/Chat.tsx";
import type {
  SessionDetail,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";
import { deferred } from "../../helpers/async.ts";

const summary = (id: string): SessionSummary => ({
  archived: null,
  attention: null,
  attentionReason: null,
  attentionSource: null,
  attentionBy: null,
  id,
  projectId: "p1",
  ownerId: "u1",
  agentId: null,
  origin: "chat",
  automationId: null,
  runSource: null,
  forkedFromId: null,
  title: `chat ${id}`,
  status: "done",
  revision: 1,
  createdAt: 1,
  lastActivityAt: 1,
  usage: null,
  disabledCapabilities: [],
});

const detail = (id: string): SessionDetail => ({
  session: summary(id),
  forkedFrom: null,
  messages: [],
  send: null,
  sends: [],
  live: [],
  authors: [],
  agents: [],
  archive: null,
  queued: [],
  automationDrafts: [],
});

const realFetch = globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
// the answers held back, by session id
let held: Map<string, ReturnType<typeof deferred<Response>>>;

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
  held = new Map();
  globalThis.fetch = (async (url: string) => {
    const id = url.match(/^\/api\/sessions\/(\w+)$/)?.[1];
    if (id === undefined) return Response.json({ agents: [] });
    const answer = deferred<Response>();
    held.set(id, answer);
    return answer.promise;
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

// the bones of a waiting chat, and no real composer among them
function expectWaiting(html: string, label: string) {
  expect(html.match(/role="status"/g)?.length).toBe(1);
  expect(html).toContain(`aria-label="${label}"`);
  expect(html.split('class="chat-waiting-turn"').length - 1).toBe(3);
  expect(html).not.toContain(">Loading<");
  expect(html).not.toContain('name="message"');
}

test.serial("a chat loading draws its turns and composer in bones", () => {
  void loadSession("s1");
  const html = render(<Chat params={{ id: "s1" }} />);
  expectWaiting(html, "Loading the chat");
  expect(html).toContain("card chat-waiting-composer");
  // the head stays the page's own
  expect(html).toContain(">Chat<");
  // a run's foot is its state line, no composer
  const run = render(<Run params={{ id: "s1" }} />);
  expectWaiting(run, "Loading the run");
  expect(run).not.toContain("chat-waiting-composer");
});

test.serial("a kept chat draws at once, with no bones", async () => {
  const first = loadSession("s1");
  held.get("s1")!.resolve(Response.json(detail("s1")));
  await first;
  onSocket({ type: "watched", sessionId: "s1", live: [] });
  // away to another chat keeps the settled one
  void loadSession("s2");
  expect(render(<Chat params={{ id: "s2" }} />)).toContain("chat-waiting");
  // back again: its kept copy is on screen before the answer
  void loadSession("s1");
  const html = render(<Chat params={{ id: "s1" }} />);
  expect(html).toContain(">chat s1<");
  expect(html).toContain('name="message"');
  expect(html).not.toContain("chat-waiting");
  expect(html).not.toContain("bones-bone");
});

test.serial(
  "the route draws the chat's shape while the view's code loads",
  () => {
    for (const [at, label] of [
      ["/chat/s1", "Loading the chat"],
      ["/run/s1", "Loading the run"],
    ] as const) {
      const { route, params } = match(at)!;
      const Waiting = route.view.waiting;
      const html = render(<Waiting params={params} />);
      expectWaiting(html, label);
      expect(html).toContain("page page-flush");
      expect(html).toContain("page-waiting-crumb");
    }
  },
);
