// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test } from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import { cancelVisual } from "../../../src/client/data/session-values.ts";
import {
  BUFFER_MAX,
  leaveSession,
  live,
  loadSession,
  loadToolResult,
  loadVisual,
  onSocket,
  session,
  toolResults,
  toolVisuals,
  visualPreviews,
} from "../../../src/client/data/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import {
  visualCall,
  visualDetail,
  visualFrame,
  visualRow,
} from "../../fixtures/sessions/visual-client.ts";

const realFetch = globalThis.fetch;
const key = "reply0000001:0";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fake(
  answer: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) =>
      answer(String(input), init),
    { preconnect: realFetch.preconnect },
  );
}
async function open(detail = visualDetail()) {
  fake(() => Response.json(detail));
  await loadSession(detail.session.id);
  onSocket({
    type: "watched",
    sessionId: detail.session.id,
    live: detail.live,
  });
}
function envelope(detail: SessionDetail) {
  onSocket({
    type: "session",
    projectId: detail.session.projectId,
    session: detail.session,
    messages: detail.messages,
    send: detail.send,
  });
}
function stored() {
  const detail = visualDetail();
  detail.messages = [
    visualRow({ status: "done", toolCalls: [visualCall] }),
    visualRow({
      id: "tool00000001",
      seq: 3,
      kind: "tool",
      slot: null,
      status: "done",
      toolCallId: "call1",
      toolName: "visualize",
    }),
  ];
  detail.live = null;
  detail.session.status = "done";
  return detail;
}
afterEach(() => {
  leaveSession();
  me.value = undefined;
  globalThis.fetch = realFetch;
});

test.serial(
  "visuals share the delta sequence and the watch snapshot's offsets",
  async () => {
    const detail = visualDetail();
    fake(() => Response.json(detail));
    await loadSession(detail.session.id);
    onSocket(visualFrame({ seq: 1, html: "old" }));
    onSocket(visualFrame({ seq: 3, html: "</svg>", htmlAt: 5 }));
    expect(visualPreviews.value.size).toBe(0);
    const snapshot = {
      ...detail.live!,
      seq: 2,
      drafts: [
        {
          messageId: "reply0000001",
          callIndex: 0,
          title: "Diagram",
          html: "<svg>",
        },
      ],
    };
    onSocket({ type: "watched", sessionId: detail.session.id, live: snapshot });
    expect(visualPreviews.value.get(key)?.html).toBe("<svg></svg>");
    onSocket({
      type: "delta",
      sessionId: detail.session.id,
      sendId: "send00000001",
      messageId: "reply0000001",
      seq: 4,
      contentAt: 0,
      reasoningAt: 0,
      content: "ok",
    });
    expect(live.value.get("reply0000001")?.content).toBe("ok");
    onSocket(visualFrame({ seq: 5, htmlAt: 11, html: "!" }));
    expect(visualPreviews.value.get(key)?.html).toBe("<svg></svg>!");
  },
);

test.serial(
  "a visual sequence gap or offset ahead refetches the detail",
  async () => {
    for (const change of [{ seq: 3 }, { htmlAt: 1 }]) {
      leaveSession();
      await open();
      let fetched = 0;
      fake(() => {
        fetched++;
        return Response.json(visualDetail());
      });
      onSocket(visualFrame(change));
      await tick();
      expect(fetched).toBe(1);
    }
  },
);

test.serial(
  "visual buffer overflow refetches and leaving cancels queued frames",
  async () => {
    const detail = visualDetail();
    fake(() => Response.json(detail));
    await loadSession(detail.session.id);
    for (let i = 0; i <= BUFFER_MAX; i++) onSocket(visualFrame({ seq: i + 1 }));
    let fetched = 0;
    fake(() => {
      fetched++;
      return Response.json(detail);
    });
    onSocket({
      type: "watched",
      sessionId: detail.session.id,
      live: detail.live,
    });
    await tick();
    expect(fetched).toBe(1);
    leaveSession();
    onSocket(visualFrame());
    onSocket({
      type: "watched",
      sessionId: detail.session.id,
      live: detail.live,
    });
    expect(visualPreviews.value.size).toBe(0);
  },
);

test.serial(
  "a stored call drops drafts, failure reads the tool result and regenerate clears",
  async () => {
    await open();
    onSocket(visualFrame());
    const detail = stored();
    detail.session.revision = 2;
    detail.messages[1]!.status = "failed";
    envelope(detail);
    expect(visualPreviews.value.get(key)).toMatchObject({
      phase: "waiting",
      html: "",
    });
    fake((url) => {
      expect(url).toEndWith("/tool00000001/result");
      return Response.json({
        content: "visual exceeds the budget",
        bytes: 25,
        cut: false,
      });
    });
    await loadToolResult("tool00000001");
    expect(toolResults.value.get("tool00000001")).toMatchObject({
      status: "done",
      content: "visual exceeds the budget",
    });
    onSocket({
      type: "session",
      projectId: detail.session.projectId,
      session: { ...detail.session, revision: 3 },
      messages: [],
      removedMessageIds: detail.messages.map((row) => row.id),
      send: null,
    });
    expect(visualPreviews.value.size).toBe(0);
    expect(toolResults.value.size).toBe(0);
  },
);

test.serial(
  "a stop mid-stream keeps the last preview only until navigation",
  async () => {
    await open();
    onSocket(visualFrame());
    const detail = visualDetail();
    detail.session.revision = 2;
    detail.session.status = "stopped";
    detail.messages[0]!.status = "stopped";
    detail.send!.status = "stopped";
    envelope(detail);
    expect(visualPreviews.value.get(key)).toMatchObject({
      phase: "failed",
      html: "<svg>",
      error: "stopped",
    });
    leaveSession();
    detail.live = null;
    await open(detail);
    expect(visualPreviews.value.size).toBe(0);
  },
);

test.serial(
  "stored visuals fetch once and a removed row cannot receive a late answer",
  async () => {
    const detail = stored();
    await open(detail);
    let fetched = 0;
    let release!: (value: Response) => void;
    let signal: AbortSignal | undefined | null;
    fake((url, init) => {
      expect(url).toEndWith("/reply0000001/calls/0/visual");
      signal = init?.signal;
      fetched++;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = loadVisual("reply0000001", 0);
    await loadVisual("reply0000001", 0);
    expect(fetched).toBe(1);
    onSocket({
      type: "session",
      projectId: detail.session.projectId,
      session: { ...detail.session, revision: 2 },
      messages: [],
      removedMessageIds: ["reply0000001"],
      send: null,
    });
    expect(signal?.aborted).toBe(true);
    release(Response.json({ title: "Old", html: "<svg/>" }));
    await pending;
    expect(toolVisuals.value.size).toBe(0);
  },
);

test.serial(
  "unmount cancels a fetch and a remount owns its own answer",
  async () => {
    await open(stored());
    const answers: Array<(value: Response) => void> = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    fake((_url, init) => {
      signals.push(init?.signal);
      return new Promise((resolve) => {
        answers.push(resolve);
      });
    });
    const old = loadVisual("reply0000001", 0);
    cancelVisual("reply0000001", 0);
    expect(signals[0]?.aborted).toBe(true);
    const next = loadVisual("reply0000001", 0);
    answers[1]!(Response.json({ title: "New", html: "<svg/>" }));
    await next;
    answers[0]!(Response.json({ title: "Old", html: "<div/>" }));
    await old;
    expect(toolVisuals.value.get(key)).toEqual({
      status: "done",
      title: "New",
      html: "<svg/>",
    });
  },
);

test.serial(
  "stored visual errors are shown and signing out aborts pending reads",
  async () => {
    await open(stored());
    fake(() => Response.json({ error: "no such visual" }, { status: 404 }));
    await loadVisual("reply0000001", 0);
    expect(toolVisuals.value.get(key)).toEqual({
      status: "failed",
      error: "No such visual.",
    });
    me.value = {
      id: "another",
      username: "another",
      role: "member",
      fullName: "",
      mustChangePassword: false,
    };
    expect(toolVisuals.value.size).toBe(0);
    expect(session.value).toBeNull();
  },
);
