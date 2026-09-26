// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Reply } from "../../../src/client/transcript/Reply.tsx";
import {
  groupRows,
  type ReplyNode,
} from "../../../src/client/transcript/rows.ts";
import {
  PAINT_MS,
  readTheme,
  THEME_TOKENS,
  VisualPlayer,
  type VisualPost,
  visualReply,
} from "../../../src/client/transcript/Visual.model.ts";
import { Visual } from "../../../src/client/transcript/Visual.tsx";
import {
  applyVisual,
  isFileCard,
  reconcileVisuals,
  snapshotVisuals,
  visualCards,
} from "../../../src/client/transcript/visuals.ts";
import { visualMessage } from "../../../src/server/tools/visual-painter.ts";
import { VISUAL_FRAME_BYTES } from "../../../src/shared/words.ts";
import {
  rejectedVisualReplies,
  visualCall,
  visualDetail,
  visualFrame,
  visualRow,
} from "../../fixtures/sessions/visual-client.ts";

const theme = readTheme("dark", () => "token");
function player() {
  let now = 0;
  let closed = 0;
  const posts: VisualPost[] = [];
  const timers = new Set<{ at: number; fn: () => void }>();
  const model = new VisualPlayer({
    post: (post) => {
      posts.push(post);
    },
    close: () => {
      closed++;
    },
    now: () => now,
    changed: () => {},
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  });
  return {
    model,
    posts,
    timers,
    get closed() {
      return closed;
    },
    ready() {
      expect(model.load()).toBe(true);
      model.setTheme(theme);
      model.receive({ type: "ready" }, true);
    },
    tick(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
  };
}

test("accepts only bounded exact replies on the connected port", () => {
  const app = player();
  app.model.receive({ type: "ready" }, true);
  expect(app.model.status.state).toBe("loading");
  app.model.load();
  app.model.receive({ type: "ready" }, false);
  for (const reply of rejectedVisualReplies) {
    expect(visualReply(reply)).toBe(false);
    app.model.receive(reply, true);
  }
  expect(app.model.status.state).toBe("loading");
  app.model.receive({ type: "ready" }, true);
  expect(app.model.status.state).toBe("ready");
  app.model.receive({ type: "connect" }, true);
  app.model.receive({ type: "height", height: -500 }, true);
  expect(app.model.status.height).toBe(80);
  app.model.receive({ type: "height", height: 120.3 }, true);
  expect(app.model.status.height).toBe(121);
  app.model.receive({ type: "height", height: Number.MAX_VALUE }, true);
  expect(app.model.status.height).toBe(2000);
});

test("queues only the latest preview before ready and always posts theme first", () => {
  const app = player();
  app.model.draw("one");
  app.model.draw("two");
  expect(app.posts).toEqual([]);
  app.ready();
  expect(app.posts).toEqual([theme, { type: "paint", html: "two" }]);
  app.model.receive({ type: "ready" }, true);
  expect(app.posts).toHaveLength(2);
  expect(app.posts.every(visualMessage)).toBe(true);
});

test("throttles whole previews to 150 ms with one trailing latest paint", () => {
  const app = player();
  app.ready();
  app.model.draw("first");
  app.tick(30);
  app.model.draw("second");
  app.tick(30);
  app.model.draw("latest");
  expect(app.timers.size).toBe(1);
  app.tick(PAINT_MS - 61);
  expect(app.posts.at(-1)).toEqual({ type: "paint", html: "first" });
  app.tick(1);
  expect(app.posts.at(-1)).toEqual({ type: "paint", html: "latest" });
  expect(app.timers.size).toBe(0);
});

test("final before ready replaces the paint and is posted once without a preview", () => {
  const app = player();
  app.model.draw("preview");
  app.model.draw("whole", true);
  app.model.draw("late");
  app.model.draw("second", true);
  app.ready();
  expect(app.posts).toEqual([theme, { type: "final", html: "whole" }]);
  expect(app.model.status.state).toBe("finalizing");
  app.model.receive({ type: "finalized" }, true);
  expect(app.model.status.state).toBe("finalized");
  const light = readTheme("light", () => "next");
  app.model.setTheme(light);
  app.model.setTheme(light);
  app.model.draw("again", true);
  expect(app.posts).toEqual([theme, { type: "final", html: "whole" }, light]);
});

test("final cancels a queued preview without waiting for the throttle", () => {
  const app = player();
  app.ready();
  app.model.draw("preview");
  app.model.draw("queued");
  app.model.draw("final", true);
  app.tick(1000);
  expect(app.timers.size).toBe(0);
  expect(app.posts.slice(1)).toEqual([
    { type: "paint", html: "preview" },
    { type: "final", html: "final" },
  ]);
});

test("navigation and unmount cancel posts and close the port", () => {
  for (const navigate of [true, false]) {
    const app = player();
    app.ready();
    app.model.draw("first");
    app.model.draw("queued");
    const stale = [...app.timers][0]!.fn;
    if (navigate) {
      expect(app.model.load()).toBe(false);
      expect(app.model.status).toMatchObject({
        state: "navigated",
        error: "the visual navigated away",
      });
    } else app.model.dispose();
    expect(app.closed).toBe(1);
    stale();
    app.tick(200);
    app.model.draw("late", true);
    app.model.setTheme(readTheme("light", () => "late"));
    app.model.receive({ type: "ready" }, true);
    expect(app.posts).toHaveLength(2);
  }
});

test("failure stops queued work and never runs scripts", () => {
  const app = player();
  app.ready();
  app.model.draw("first");
  app.model.draw("queued");
  app.model.fail("stopped");
  app.model.draw("final", true);
  app.tick(200);
  expect(app.model.status).toMatchObject({ state: "failed", error: "stopped" });
  expect(app.posts).toHaveLength(2);
});

test("a failed draft can paint inertly after ready without losing its reason", () => {
  const app = player();
  app.model.fail("stopped", "<svg/>");
  app.ready();
  expect(app.posts).toEqual([theme, { type: "paint", html: "<svg/>" }]);
  expect(app.model.status).toMatchObject({ state: "failed", error: "stopped" });
  app.model.draw("never", true);
  expect(app.posts).toHaveLength(2);
});

test("oversized fragments fail locally and themes carry the page's tokens", () => {
  const app = player();
  app.ready();
  app.model.draw("é".repeat(VISUAL_FRAME_BYTES / 2 + 1));
  expect(app.model.status.state).toBe("failed");
  expect(app.posts).toEqual([theme]);
  expect(
    Object.keys(readTheme("only dark", (name) => ` ${name} `).values),
  ).toEqual([...THEME_TOKENS]);
  expect(theme.scheme).toBe("dark");
});

test("draft offsets overlap in UTF-16 and an offset ahead requests a refetch", () => {
  const first = applyVisual(new Map(), visualFrame({ html: "🦊" })).previews;
  const next = applyVisual(first, visualFrame({ html: "🦊<svg>", seq: 2 }));
  expect(next.gap).toBe(false);
  expect([...next.previews.values()][0]?.html).toBe("🦊<svg>");
  expect(applyVisual(first, visualFrame({ htmlAt: 3 })).gap).toBe(true);
});

test("storing drops the draft source but retains its card until the result", () => {
  const before = applyVisual(new Map(), visualFrame()).previews;
  const detail = visualDetail();
  detail.messages = [visualRow({ status: "done", toolCalls: [visualCall] })];
  const after = reconcileVisuals(before, detail);
  expect([...after.values()][0]).toMatchObject({ phase: "waiting", html: "" });
  const node = groupRows(detail.messages, detail.send)[0] as ReplyNode;
  expect(visualCards(node, after)).toHaveLength(1);
  expect(visualCards(node, new Map())).toHaveLength(0);
});

test("a stopped draft fades with its reason and is removed with its rows", () => {
  const before = applyVisual(new Map(), visualFrame()).previews;
  const detail = visualDetail();
  detail.messages = [
    visualRow({ status: "failed", error: "provider went quiet" }),
  ];
  detail.live = null;
  const after = snapshotVisuals(before, detail);
  expect([...after.values()][0]).toMatchObject({
    phase: "failed",
    html: "<svg>",
    error: "provider went quiet",
  });
  expect(snapshotVisuals(new Map(), detail).size).toBe(0);
  expect(reconcileVisuals(after, { ...detail, messages: [] }).size).toBe(0);
});

test("stored cards follow call order, never a failed whole call or memory row", () => {
  const detail = visualDetail();
  detail.messages = [
    visualRow({ status: "done", toolCalls: [visualCall, visualCall] }),
    visualRow({
      id: "tool1",
      seq: 3,
      kind: "tool",
      slot: null,
      status: "done",
      toolCallId: "call1",
      toolName: "visualize",
    }),
    visualRow({
      id: "tool2",
      seq: 4,
      kind: "tool",
      slot: null,
      status: "failed",
      toolCallId: "call1",
      toolName: "visualize",
    }),
  ];
  const node = groupRows(detail.messages, detail.send)[0] as ReplyNode;
  const drawn = visualCards(node, new Map()).flatMap((card) =>
    isFileCard(card) ? [] : [card],
  );
  expect(drawn.map((card) => card.callIndex)).toEqual([0]);
  const markup = render(
    <Reply
      node={node}
      live={new Map()}
      agent={null}
      visuals={drawn.map((card) => <Visual card={card} />)}
    />,
  );
  expect(markup).toContain('src="/api/visual"');
  expect(markup).toContain('sandbox="allow-scripts"');
  expect(markup).toContain('referrerpolicy="no-referrer"');
  expect(markup).toContain('width="680"');
  expect(markup.indexOf("transcript-work")).toBeLessThan(
    markup.indexOf("visual-card"),
  );
  expect(
    visualCards({ ...node, work: null, memory: node.work }, new Map()),
  ).toEqual([]);
});
