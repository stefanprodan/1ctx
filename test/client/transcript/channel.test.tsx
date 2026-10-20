// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The channel's transcript: an answer opens with its post's quote, a
// pending turn is one line under its post, the context line sits at the
// dropped mark, each running turn has its own working line and retry,
// Stop and Cancel show only to the summoner and admins, and the lines
// for older pages and a gap. A chat draws none of it.

import { describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import {
  firstLine,
  lineAt,
  mayAct,
  nodeKey,
  pendingWords,
  prepended,
  quoteOf,
} from "../../../src/client/transcript/Channel.model.ts";
import type { ChannelView } from "../../../src/client/transcript/Channel.tsx";
import { groupRows } from "../../../src/client/transcript/rows.ts";
import { Transcript } from "../../../src/client/transcript/Transcript.tsx";
import type {
  LiveRetry,
  Message,
  PendingTurn,
  SendSummary,
} from "../../../src/shared/contracts/session.ts";

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
    createdAt: Date.UTC(2026, 9, 20, 9),
    finishedAt: Date.UTC(2026, 9, 20, 9, 1),
    ...changes,
  };
}

const post = (seq: number, content: string, userId = "u1"): Message =>
  row({
    id: `p${seq}`,
    seq,
    kind: "user",
    sendId: `post-${seq}`,
    slot: null,
    userId,
    agentId: null,
    content,
    finishReason: null,
    model: null,
  });

const turn = (
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
  startedAt: Date.UTC(2026, 9, 20, 9),
  finishedAt: null,
  ...changes,
});

const users: Record<string, string> = { u1: "Casey", u2: "Robin" };

function view(changes: Partial<ChannelView> = {}): ChannelView {
  return {
    viewer: { id: "u1", admin: false },
    pending: [],
    droppedSeq: null,
    shown: () => true,
    agentName: (id) => (id === "a1" ? "coder" : "reviewer"),
    onStop: async () => {},
    onCancel: async () => {},
    onQuote: async () => {},
    older: { more: false, loading: false, failure: null, onOlder: () => {} },
    gap: null,
    focus: null,
    onFocused: () => {},
    ...changes,
  };
}

function draw(
  messages: Message[],
  sends: SendSummary[],
  channel?: ChannelView,
  retries: ReadonlyMap<string, LiveRetry> = new Map(),
): string {
  return render(
    <Transcript
      sessionId="c1"
      nodes={groupRows(messages, null, sends)}
      live={new Map()}
      retries={retries}
      agentOf={(id) =>
        id === null
          ? null
          : { name: id === "a1" ? "coder" : "reviewer", avatar: "bot" }
      }
      authorOf={(id) => ({
        name: users[id ?? ""] ?? "someone",
        username: id,
      })}
      channel={channel}
    />,
  );
}

// a post with its answer, and a second post whose turn runs
const twoTurns = () => ({
  messages: [
    post(10, "Why did the bill grow?\nThe second line"),
    row({
      id: "r11",
      seq: 11,
      sendId: "t10",
      content: "Storage did.",
      html: "<p>Storage did.</p>",
    }),
    post(20, "@reviewer check the alerts", "u2"),
    row({
      id: "r21",
      seq: 21,
      sendId: "t20",
      agentId: "a2",
      slot: null,
      status: "streaming",
      finishReason: null,
    }),
  ],
  sends: [
    turn("t10", 10),
    turn("t20", 20, { status: "running", userId: "u2" }),
  ],
});

describe("the channel's lines", () => {
  test("the summoner and an admin act on a turn", () => {
    expect(mayAct({ id: "u1", admin: false }, "u1")).toBe(true);
    expect(mayAct({ id: "u2", admin: false }, "u1")).toBe(false);
    expect(mayAct({ id: "u2", admin: true }, "u1")).toBe(true);
    expect(mayAct(null, "u1")).toBe(false);
  });

  test("a quote is the post's first line with words", () => {
    expect(firstLine("\n  \n first  \nsecond")).toBe("first");
    const posts = new Map([["p1", post(1, "hello\nthere")]]);
    expect(quoteOf("p1", posts)?.line).toBe("hello");
    expect(quoteOf("p9", posts)).toBeNull();
    expect(quoteOf(null, posts)).toBeNull();
  });

  test("a pending turn says who it waits for, or why it did not start", () => {
    expect(pendingWords("coder", null)).toBe("Waiting for @coder");
    expect(pendingWords("coder", "expired")).toBe(
      "@coder did not start: waited too long",
    );
    expect(pendingWords("coder", "agent-deleted")).toBe(
      "@coder did not start: the agent was deleted",
    );
    expect(pendingWords("coder", "failed")).toBe("@coder did not start");
  });

  test("a line goes before the first node at its seq, never the first", () => {
    const { messages, sends } = twoTurns();
    const nodes = groupRows(messages, null, sends);
    expect(lineAt(nodes, 20)).toBe(2);
    expect(lineAt(nodes, 11)).toBe(1);
    expect(lineAt(nodes, 10)).toBeNull();
    expect(lineAt(nodes, 5)).toBeNull();
    expect(lineAt(nodes, 99)).toBeNull();
    expect(lineAt(nodes, null)).toBeNull();
  });

  test("rows that land above the first one are a page prepended", () => {
    expect(prepended("user:p2", ["user:p1", "user:p2"])).toBe(true);
    expect(prepended("user:p1", ["user:p1", "user:p2"])).toBe(false);
    expect(prepended("user:p9", ["user:p1"])).toBe(false);
    expect(prepended(null, ["user:p1"])).toBe(false);
    const { messages, sends } = twoTurns();
    expect(groupRows(messages, null, sends).map(nodeKey)).toEqual([
      "user:p10",
      "reply:t10",
      "user:p20",
      "reply:t20",
    ]);
  });
});

describe("the channel's transcript", () => {
  test("an answer opens with its post's quote, which leads to it", () => {
    const { messages, sends } = twoTurns();
    const opened: { id: string; seq: number }[] = [];
    const html = draw(
      messages,
      sends,
      view({
        onQuote: async (target) => {
          opened.push({ id: target.id, seq: target.seq });
        },
      }),
    );
    expect(html).toContain('class="channel-quote"');
    expect(html).toContain('title="Casey: Why did the bill grow?"');
    expect(html).toContain(
      '<span class="channel-quote-text cut">Why did the bill grow?</span>',
    );
    expect(html).toContain('title="Robin: @reviewer check the alerts"');
    expect(html).not.toContain("The second line</span>");
    // a click reads the post's window when needed, so it names id and seq
    const clicks: (() => void)[] = [];
    const previous = options.vnode;
    options.vnode = (node: VNode) => {
      previous?.(node);
      const props = node.props as Record<string, unknown>;
      if (props.class === "channel-quote") {
        clicks.push(props.onClick as () => void);
      }
    };
    try {
      draw(
        messages,
        sends,
        view({ onQuote: async (t) => void opened.push(t) }),
      );
    } finally {
      options.vnode = previous;
    }
    clicks[0]!();
    expect(opened[0]).toMatchObject({ id: "p10", seq: 10 });
  });

  test("a quoted post above the pages still names its answer", () => {
    const { messages, sends } = twoTurns();
    const html = draw(messages, sends, view({ shown: (seq) => seq !== 10 }));
    // the post's card waits for its window, its quote does not
    expect(html).not.toContain("The second line");
    expect(html).toContain('title="Casey: Why did the bill grow?"');
  });

  test("posts say their day, since a channel has no day lines", () => {
    const { messages, sends } = twoTurns();
    expect(draw(messages, sends, view())).toContain("Oct 20, ");
    expect(draw(messages, sends, view())).toContain('data-post="p10"');
  });

  test("the context line sits at the dropped mark, and only when set", () => {
    const { messages, sends } = twoTurns();
    const marked = draw(messages, sends, view({ droppedSeq: 20 }));
    expect(marked.match(/Context starts here/g)).toHaveLength(1);
    expect(marked.indexOf("Context starts here")).toBeLessThan(
      marked.indexOf("@reviewer check the alerts"),
    );
    expect(marked.indexOf("Context starts here")).toBeGreaterThan(
      marked.indexOf("Storage did."),
    );
    expect(draw(messages, sends, view())).not.toContain("Context starts here");
  });

  test("each running turn has its own working line and retry", () => {
    const messages = [
      post(10, "@coder look"),
      post(20, "@reviewer look", "u2"),
      row({
        id: "r11",
        seq: 11,
        sendId: "tA",
        slot: null,
        status: "streaming",
      }),
      row({
        id: "r21",
        seq: 21,
        sendId: "tB",
        agentId: "a2",
        slot: null,
        status: "streaming",
      }),
    ];
    const sends = [
      turn("tA", 10, { status: "running" }),
      turn("tB", 20, { status: "running", userId: "u2" }),
    ];
    const html = draw(
      messages,
      sends,
      view(),
      new Map([["tB", { attempt: 1, max: 3 }]]),
    );
    expect(
      html.match(/transcript-fold transcript-work transcript-fold-live/g),
    ).toHaveLength(2);
    expect(html.match(/Working/g)).toHaveLength(2);
    expect(html.match(/retrying 1\/3/g)).toHaveLength(1);
    expect(html.indexOf("retrying 1/3")).toBeGreaterThan(
      html.indexOf("@reviewer look"),
    );
  });

  test("Stop shows only to the turn's summoner and to admins", () => {
    const { messages, sends } = twoTurns();
    const stops = (viewer: ChannelView["viewer"]) =>
      draw(messages, sends, view({ viewer })).match(/aria-label="Stop"/g)
        ?.length ?? 0;
    // t20 runs, summoned by u2
    expect(stops({ id: "u2", admin: false })).toBe(1);
    expect(stops({ id: "u1", admin: true })).toBe(1);
    expect(stops({ id: "u1", admin: false })).toBe(0);
    expect(stops(null)).toBe(0);
  });

  test("a pending turn is one line under its post, Cancel for its summoner", () => {
    const { messages, sends } = twoTurns();
    const pending: PendingTurn[] = [
      {
        id: "w1",
        messageId: "p10",
        authorId: "u1",
        agentId: "a2",
        queuedAt: 1,
        reason: null,
      },
    ];
    const mine = draw(messages, sends, view({ pending }));
    expect(mine).toContain('class="channel-pending"');
    expect(mine).toContain("Waiting for @reviewer");
    expect(mine).toContain(">Cancel</button>");
    expect(mine.indexOf("Waiting for @reviewer")).toBeGreaterThan(
      mine.indexOf("Why did the bill grow?"),
    );
    expect(mine.indexOf("Waiting for @reviewer")).toBeLessThan(
      mine.indexOf("Storage did."),
    );
    const admin = draw(
      messages,
      sends,
      view({ pending, viewer: { id: "u2", admin: true } }),
    );
    expect(admin).toContain(">Cancel</button>");
    const other = draw(
      messages,
      sends,
      view({ pending, viewer: { id: "u2", admin: false } }),
    );
    expect(other).toContain("Waiting for @reviewer");
    expect(other).not.toContain(">Cancel</button>");
    const expired = draw(
      messages,
      sends,
      view({ pending: [{ ...pending[0]!, reason: "expired" }] }),
    );
    expect(expired).toContain("@reviewer did not start: waited too long");
    expect(expired).toContain(">Dismiss</button>");
  });

  test("older pages and a gap are one small line each", () => {
    const { messages, sends } = twoTurns();
    const more = { more: true, loading: false, failure: null, onOlder() {} };
    expect(draw(messages, sends, view({ older: more }))).toContain(
      ">Show older</button>",
    );
    expect(
      draw(messages, sends, view({ older: { ...more, loading: true } })),
    ).toContain(">Loading</span>");
    const failed = draw(
      messages,
      sends,
      view({ older: { ...more, failure: "The server broke." } }),
    );
    expect(failed).toContain("The server broke.");
    expect(failed).toContain(">Try again</button>");
    const gap = draw(
      messages,
      sends,
      view({ gap: { before: 20, onGap: async () => {} } }),
    );
    expect(gap).toContain(">Show newer</button>");
    expect(gap.indexOf("Show newer")).toBeLessThan(
      gap.indexOf("@reviewer check the alerts"),
    );
  });

  test("a chat draws none of the channel's lines", () => {
    const messages = [
      row({ id: "u", seq: 1, kind: "user", userId: "u1", sendId: "s1" }),
      row({ id: "a", seq: 2, sendId: "s1", content: "Hi." }),
    ];
    const html = draw(messages, []);
    expect(html).not.toContain("channel-");
    expect(html).not.toContain("data-post");
    // the user row keeps its time alone; the day is the answer's stamp
    expect(html.match(/Oct 20, /g)).toHaveLength(1);
  });
});
