// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A reply's /knowledge/ paths link to its session's project, in the
// streamed html and the stored row alike, a subagent's included.

import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../../src/server/render/index.ts";
import { finishReplyRow } from "../../../src/server/runner/reply-rows.ts";
import type { ActiveSend } from "../../../src/server/runner/send.ts";
import { newRound } from "../../../src/server/runner/send.ts";
import { HTML_MIN_MS, streamDelta } from "../../../src/server/runner/stream.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";
import { startChat, waitScript } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";
import {
  childrenOf,
  delegateCall,
  settled,
  subagentApp,
} from "../../helpers/subagents.ts";

const link = (project: string, name: string) =>
  `<a class="md-link md-path" href="/projects/${project}/knowledge/path?name=${name}">/knowledge/${name}</a>`;

describe("knowledge links in replies", () => {
  test("a streamed frame and the stored row carry the same link", () => {
    let now = 1_000;
    const frames: SocketEvent[] = [];
    let stored = "";
    const send = {
      id: "send-1",
      sessionId: "chat-1",
      projectId: "proj00000001",
      seq: 0,
      round: newRound("reply-1", now),
    } as unknown as ActiveSend;
    const deps = {
      clock: () => now,
      sessions: {
        writeReply: () => true,
        finishReply: (_: string, fields: { html: string }) => {
          stored = fields.html;
          return null;
        },
      },
      usage: { record: () => {} },
      render: renderMarkdown,
      stream: (_: string, frame: SocketEvent) => frames.push(frame),
    };
    streamDelta(deps, send, {
      kind: "content",
      text: "See /knowledge/x.md.\n\n",
    });
    now += HTML_MIN_MS;
    streamDelta(deps, send, { kind: "content", text: "Then" });
    const html = frames.flatMap((f) => (f.type === "html" ? [f.html] : []));
    const expected = link("proj00000001", "x.md");
    expect(html).toEqual([`<p class="md-p">See ${expected}.</p>`]);
    finishReplyRow(
      deps as unknown as Parameters<typeof finishReplyRow>[0],
      send,
      send.round!,
      "done",
      null,
      "answer",
      null,
      now,
    );
    expect(stored).toBe(`${html[0]}<p class="md-p">Then</p>`);
  });

  test.serial("a subagent's reply links in its project", async () => {
    const chat = await subagentApp();
    try {
      const team = await createTeam(chat.admin, "ops", [chat.memberId]);
      const { script, sessionId } = await startChat(
        chat,
        "survey",
        chat.member,
        team.id,
      );
      script.toolRound([delegateCall("d1", "Find the plan.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      child.reply("It is /knowledge/plan.md");
      const parent = await waitScript(chat.scripted, 3);
      parent.reply("Read /knowledge/plan.md");
      await settled(chat, sessionId);
      const expected = `<p class="md-p">It is ${link(team.id, "plan.md")}</p>`;
      const [childId] = childrenOf(chat, sessionId);
      const childReply = chat.app.sessions
        .messages(childId!)
        .findLast((row) => row.kind === "reply");
      expect(childReply?.html).toBe(expected);
      const rootReply = chat.app.sessions
        .messages(sessionId)
        .findLast((row) => row.kind === "reply");
      expect(rootReply?.html).toBe(
        `<p class="md-p">Read ${link(team.id, "plan.md")}</p>`,
      );
    } finally {
      await chat.app.shutdown();
    }
  });
});
