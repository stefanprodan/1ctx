// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Rows from before the attention verdict keep the old tool name,
// needs_attention: a run holding them still lists, opens, forks and
// builds its history.

import { describe, expect, test } from "bun:test";
import { historyMessages } from "../../../src/server/runner/context.ts";
import type { Offered } from "../../../src/server/tools/index.ts";
import {
  answerRun,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import { chatApp, type Script } from "../../helpers/chat.ts";

const OLD = "needs_attention";

const flag = (script: Script) => {
  script.toolRound([
    {
      id: "c1",
      name: "attention",
      arguments: JSON.stringify({ needed: true, reason: "podinfo is down" }),
    },
  ]);
  script.end();
};

describe("an old run with a needs_attention row", () => {
  test("lists, opens, forks and builds its history", async () => {
    const chat = await chatApp();
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
      });
      const run = await startRun(chat, automation.id);
      await answerRun(chat, run.main, "Pods are down.", flag);
      await settleRun(chat, run.sessionId);
      // the rows as the step stored them before the rename
      chat.app.db.run(
        "update messages set tool_name = ? where session_id = ? and kind = 'tool'",
        [OLD, run.sessionId],
      );
      chat.app.db.run(
        "update messages set tool_calls = replace(tool_calls, '\"attention\"', ?) where session_id = ? and tool_calls is not null",
        [`"${OLD}"`, run.sessionId],
      );

      const opened = await chat.member.call(
        "GET",
        `/api/sessions/${run.sessionId}`,
      );
      expect(opened.status).toBe(200);
      const detail = await opened.json();
      expect(detail.session).toMatchObject({
        attention: 1,
        attentionReason: "podinfo is down",
        attentionSource: "agent",
      });
      const rows = detail.messages as { toolName: string | null }[];
      expect(rows.some((row) => row.toolName === OLD)).toBeTrue();

      const listed = await chat.member.call(
        "GET",
        `/api/sessions?project=${chat.projectId}`,
      );
      expect(listed.status).toBe(200);
      expect(
        (await listed.json()).rows.map(
          (row: { session: { id: string } }) => row.session.id,
        ),
      ).toContain(run.sessionId);

      const stored = chat.app.sessions.messages(run.sessionId);
      const history = historyMessages(
        stored,
        {
          username: "casey",
          userId: "u1",
          providerId: "p",
          model: "m",
          offered: {
            tools: [],
            mcp: [],
            skills: { block: "", skills: [] },
          } as unknown as Offered,
          agentId: chat.agentId,
          summoned: null,
        },
        {
          usernameOf: () => null,
          reasoningDetailsOf: () => null,
          turnsOf: () => new Map(),
        },
      );
      expect(history).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          toolCalls: [expect.objectContaining({ id: "c1", name: OLD })],
        }),
      );
      expect(history).toContainEqual({
        role: "tool",
        toolCallId: "c1",
        content: "Marked.",
      });

      const answer = stored.find((row) => row.slot === "answer")!;
      const forked = await chat.member.call(
        "POST",
        `/api/sessions/${run.sessionId}/fork`,
        { body: { messageId: answer.id, agentId: chat.agentId } },
      );
      expect(forked.status).toBe(201);
    } finally {
      await chat.app.shutdown();
    }
  });
});
