// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  childWork,
  mergeWork,
  resetChildren,
  takeChildren,
} from "../../../src/client/data/session-children.ts";
import { session } from "../../../src/client/data/session-held.ts";
import {
  childHead,
  childStatus,
  childView,
  isDelegate,
} from "../../../src/client/transcript/Delegate.model.ts";
import {
  groupRows,
  type ReplyNode,
} from "../../../src/client/transcript/rows.ts";
import { workSummary } from "../../../src/client/transcript/Work.model.ts";
import { Work } from "../../../src/client/transcript/Work.tsx";
import type {
  ChildWork,
  Message,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";

function row(changes: Partial<Message> & Pick<Message, "id" | "seq">): Message {
  return {
    sessionId: "root",
    kind: "reply",
    sendId: "send-1",
    round: 1,
    slot: null,
    userId: null,
    agentId: "agent-1",
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
    model: "model",
    ttftMs: null,
    thinkingMs: null,
    upstream: null,
    servedModel: null,
    nativeFinish: null,
    createdAt: 1_000,
    finishedAt: 2_000,
    ...changes,
  };
}

const delegateArgs = JSON.stringify({
  description: "check the clock",
  task: "Read the clock in UTC.",
});

// the root's turn: a work round with one delegate call, its tool row
// and the answer
function rootRows(status: Message["status"] = "done"): Message[] {
  return [
    row({ id: "user-1", seq: 1, kind: "user", userId: "u", content: "go" }),
    row({
      id: "work-1",
      seq: 2,
      slot: "work",
      finishReason: "tool_calls",
      toolCalls: [{ id: "d1", name: "delegate", arguments: delegateArgs }],
    }),
    row({
      id: "delegate-1",
      seq: 3,
      kind: "tool",
      toolCallId: "d1",
      toolName: "delegate",
      status,
      resultBytes: 10,
      childSessionId: "child-1",
    }),
    ...(status === "streaming"
      ? []
      : [
          row({
            id: "answer-1",
            seq: 4,
            round: 2,
            slot: "answer",
            content: "noon",
          }),
        ]),
  ];
}

const childRows = (): Message[] => [
  row({ id: "c-user", seq: 1, sessionId: "child-1", kind: "user" }),
  row({
    id: "c-work",
    seq: 2,
    sessionId: "child-1",
    slot: "work",
    content: "Reading it now.",
    finishReason: "tool_calls",
    toolCalls: [
      { id: "c1", name: "datetime", arguments: '{"timezone":"UTC"}' },
    ],
  }),
  row({
    id: "c-tool",
    seq: 3,
    sessionId: "child-1",
    kind: "tool",
    toolCallId: "c1",
    toolName: "datetime",
    resultBytes: 20,
  }),
  row({
    id: "c-answer",
    seq: 4,
    sessionId: "child-1",
    round: 2,
    slot: "answer",
    content: "It is noon.",
    html: "<p>It is noon.</p>",
  }),
];

const work = (changes: Partial<ChildWork> = {}): ChildWork => ({
  sessionId: "child-1",
  status: "done",
  tokens: 110,
  cost: 0.004,
  rows: childRows(),
  ...changes,
});

const replyOf = (rows: Message[]) =>
  groupRows(rows).find((node) => node.kind === "reply") as ReplyNode;

afterEach(() => {
  resetChildren();
  session.value = null;
});

describe("a delegate group", () => {
  test("is a delegate call that ran, headed by the child's status and tally", () => {
    const node = replyOf(rootRows()).work!;
    const call = node.rounds[0]!.calls[0]!;
    expect(isDelegate(call)).toBe(true);
    expect(isDelegate({ ...call, result: null })).toBe(false);
    const delegate = call.result!;
    expect(childStatus(delegate, null)).toBe("done");
    expect(childStatus({ ...delegate, status: "streaming" }, work())).toBe(
      "running",
    );
    // a stopped child is a failed result to its parent
    expect(
      childStatus(
        { ...delegate, status: "failed" },
        work({ status: "stopped" }),
      ),
    ).toBe("stopped");
    expect(childHead("done", work())).toBe("done · 110 tokens · <$0.01");
    expect(childHead("running", work({ tokens: 0, cost: null }))).toBe(
      "running",
    );
  });

  test("holds the child's rounds and closes with its answer", () => {
    const view = childView(childRows().reverse());
    expect(view.rounds).toHaveLength(1);
    expect(view.rounds[0]!.calls[0]!.result?.id).toBe("c-tool");
    expect(view.answer?.id).toBe("c-answer");
  });

  test("the fold counts the root's calls, the delegate one of them", () => {
    const node = replyOf(rootRows()).work!;
    expect(workSummary(node, false).toolCalls).toBe(1);
  });

  test.serial("draws the child's rows with the fold's own rows", () => {
    session.value = { session: { id: "root" } } as SessionDetail;
    takeChildren("root", [{ messageId: "delegate-1", child: work() }]);
    const reply = replyOf(rootRows());
    const html = render(
      <Work
        node={reply.work!}
        reply={reply.message}
        live={new Map()}
        running={false}
      />,
    );
    expect(html).toContain("check the clock");
    expect(html).toContain("done · 110 tokens");
    expect(html).toContain("Read the clock in UTC.");
    expect(html).toContain("Reading it now.");
    expect(html).toContain(">datetime<");
    expect(html).toContain("<p>It is noon.</p>");
  });
});

describe("a child's rows on the client", () => {
  test("an ended row never goes back to running, whichever lands last", () => {
    const ended = work();
    const stale = work({
      status: "running",
      tokens: 40,
      cost: null,
      rows: [{ ...childRows()[2]!, status: "streaming" }],
    });
    const merged = mergeWork(ended, stale);
    expect(merged.status).toBe("done");
    expect(merged.tokens).toBe(110);
    expect(merged.cost).toBe(0.004);
    expect(merged.rows.find((r) => r.id === "c-tool")?.status).toBe("done");
    expect(merged.rows.map((r) => r.id)).toEqual([
      "c-user",
      "c-work",
      "c-tool",
      "c-answer",
    ]);
  });

  test.serial(
    "a frame lands only for the chat on screen, on what is held",
    () => {
      takeChildren("root", [{ messageId: "delegate-1", child: work() }]);
      expect(childWork.value.size).toBe(0);
      session.value = { session: { id: "root" } } as SessionDetail;
      const [first, ...rest] = childRows();
      takeChildren("root", [
        {
          messageId: "delegate-1",
          child: work({ status: "running", rows: [first!] }),
        },
      ]);
      takeChildren("root", [
        { messageId: "delegate-1", child: work({ rows: rest }) },
      ]);
      const held = childWork.value.get("delegate-1")!.work!;
      expect(held.rows).toHaveLength(4);
      expect(held.status).toBe("done");
    },
  );
});
