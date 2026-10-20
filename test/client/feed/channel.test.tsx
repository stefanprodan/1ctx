// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's channel as a feed row: its #name, its two bubbles, the
// last post's author and start or "No messages yet", the chat's link,
// its project never named twice, and its row in the rail's Recent.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  readRecent,
  recentFrame,
  recentHref,
  recentIcon,
  recentKey,
  recentLook,
  recentPage,
  recentText,
  reopenStatus,
  sessionRecent,
} from "../../../src/client/app/Recent.model.ts";
import { FeedCard } from "../../../src/client/feed/FeedCard.tsx";
import {
  CHANNEL_EMPTY,
  iconOf,
  rowTitle,
  stateLine,
} from "../../../src/client/feed/Row.model.ts";
import { Row } from "../../../src/client/feed/Row.tsx";
import { Icon } from "../../../src/client/lib/icons.tsx";
import type { FeedRow } from "../../../src/shared/api/sessions.ts";
import type { SessionSummary } from "../../../src/shared/contracts/session.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

const now = new Date(2026, 9, 21, 12).getTime();

const session = (changes: Partial<SessionSummary> = {}): SessionSummary => ({
  archived: null,
  attention: null,
  attentionReason: null,
  attentionSource: null,
  attentionBy: null,
  id: "ch1",
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
  revision: 4,
  createdAt: now - 3_600_000,
  lastActivityAt: now - 5 * 60_000,
  usage: null,
  disabledCapabilities: [],
  ...changes,
});

const channel = (changes: Partial<FeedRow> = {}): FeedRow => ({
  session: session(),
  agent: null,
  agentRetired: false,
  send: null,
  sendAgent: null,
  last: { seq: 7, author: "caelea", text: "the bill doubled overnight" },
  automation: null,
  runBy: null,
  runs: null,
  ...changes,
});

const chat = (): FeedRow => ({
  ...channel(),
  session: session({
    id: "c1",
    origin: "chat",
    ownerId: "u1",
    agentId: "a1",
    title: "Which pods restarted",
  }),
  agent: "sre",
});

const draw = (row: FeedRow, projectName: string | null = null) =>
  render(<Row row={row} projectName={projectName} now={now} />);

describe("a channel's feed row", () => {
  test("is the project's #name with two bubbles", () => {
    expect(rowTitle(session())).toBe("#finops");
    expect(rowTitle(chat().session)).toBe("Which pods restarted");
    expect(iconOf(channel())).toBe("channel");
    expect(iconOf(chat())).toBe("chat");
    const html = draw(channel());
    expect(html).toContain(">#finops</span>");
    const icon = render(<Icon name="channel" size={16} />);
    const path = /<path d="([^"]+)"/.exec(icon)?.[1];
    expect(path?.match(/M/g)).toHaveLength(2);
    expect(html).toContain(`d="${path}"`);
  });

  test("says who wrote last and the start of it, whole in title", () => {
    expect(stateLine(channel())).toEqual({
      author: "caelea",
      text: "the bill doubled overnight",
    });
    const html = draw(channel());
    expect(html).toContain('<span class="feed-author">@caelea </span>');
    expect(html).toContain('title="#finops"');
    expect(html).toContain('title="@caelea the bill doubled overnight"');
  });

  test("says No messages yet before the first message", () => {
    const empty = channel({ last: null });
    expect(stateLine(empty)).toEqual({ author: null, text: CHANNEL_EMPTY });
    expect(CHANNEL_EMPTY).toBe("No messages yet");
    expect(draw(empty)).toContain("No messages yet");
    // a chat with nothing yet stays blank
    expect(stateLine({ ...chat(), last: null }).text).toBe("");
  });

  test("names the working agent while a turn runs", () => {
    const running = channel({
      session: session({ status: "running" }),
      sendAgent: { name: "sre", retired: false },
    });
    expect(stateLine(running)).toEqual({ author: "sre", text: "working" });
  });

  test("never names its project twice on Home", () => {
    const html = draw(channel(), "finops");
    expect(html).not.toContain("feed-project");
    expect(draw(chat(), "finops")).toContain(
      '<span class="feed-project">#finops</span>',
    );
  });

  test("is a feed row like a chat's, linked as a chat is", () => {
    const html = draw(channel());
    expect(html).toContain('<a class="feed-row" href="/chat/ch1">');
    const classes = (s: string) =>
      [...s.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
    // the same parts in the same order; only the status class may differ
    expect(classes(html)).toEqual(classes(draw(chat())));
  });

  test("a pinned row is drawn first as the server sends it", () => {
    const html = render(
      <FeedCard
        rows={[{ ...channel(), pinned: true }, chat()]}
        projectName={() => null}
        search={{ value: "", onChange: () => {} }}
        filter={{ value: null, onPick: () => {} }}
        empty="Nothing yet"
        now={now}
        more={{ next: false, loading: false, error: null }}
        onMore={() => {}}
      />,
    );
    expect(html.indexOf("#finops")).toBeLessThan(
      html.indexOf("Which pods restarted"),
    );
  });
});

describe("a channel in Recent", () => {
  const row = sessionRecent(session());

  test("is recorded from its page with the bubbles and #name", () => {
    expect(row).toEqual({
      kind: "channel",
      id: "ch1",
      projectId: "p1",
      automationId: null,
      title: "finops",
    });
    expect(recentPage("/chat/ch1")).toEqual({
      kind: "session",
      id: "ch1",
      record: true,
    });
    expect(recentIcon(row)).toBe("channel");
    expect(recentLook(row).icon).toBe("channel");
    expect(recentText(row)).toBe("#finops");
    expect(recentHref(row)).toBe("/chat/ch1");
    expect(recentKey(row)).toBe("channel:ch1");
  });

  test("is read back from storage", () => {
    expect(readRecent(JSON.stringify([row]))).toEqual([row]);
  });

  test("follows its project's rename and goes with a delete", () => {
    const renamed = recentFrame([row], {
      type: "session",
      projectId: "p1",
      session: session({ title: "costs" }),
      messages: [],
      send: null,
      row: null,
    } as unknown as SocketEvent);
    // stored raw, drawn with one # however often it is renamed
    expect(renamed[0]?.title).toBe("costs");
    expect(recentText(renamed[0]!)).toBe("#costs");
    expect(
      recentText(
        recentFrame(renamed, {
          type: "session",
          projectId: "p1",
          session: session({ title: "finops" }),
          messages: [],
          send: null,
          row: null,
        } as unknown as SocketEvent)[0]!,
      ),
    ).toBe("#finops");
    expect(
      recentFrame([row], {
        type: "deleted",
        sessionId: "ch1",
      } as unknown as SocketEvent),
    ).toEqual([]);
  });

  test("keeps its status while its page is open", () => {
    const statuses = { "channel:ch1": { tone: "running", paused: false } };
    expect(
      reopenStatus(statuses as never, {
        kind: "session",
        id: "ch1",
        record: true,
      }),
    ).toBe(statuses as never);
  });
});
