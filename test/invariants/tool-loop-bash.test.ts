// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../helpers/automations.ts";
import { chatApp, startChat, waitScript } from "../helpers/chat.ts";

describe("bash in the tool loop", () => {
  test.each(["chat", "automation"] as const)(
    "bash reads, edits and deletes project files as the %s's agent",
    async (origin) => {
      const chat = await chatApp();
      try {
        const created = await chat.member.call(
          "POST",
          `/api/projects/${chat.projectId}/knowledge`,
          { body: { name: "docs/x.md", text: "hello\n" } },
        );
        expect(created.status).toBe(201);
        const { file } = await created.json();
        const started =
          origin === "chat"
            ? await startChat(chat)
            : await startRun(
                chat,
                (await createAutomation(chat, { ownMemory: true })).id,
              ).then(({ sessionId, main }) => ({ sessionId, script: main }));
        const { sessionId, script } = started;
        expect(
          (script.body.tools as { function: { name: string } }[]).map(
            (tool) => tool.function.name,
          ),
        ).toEqual([
          "datetime",
          "webfetch",
          "visualize",
          "bash",
          // a run never saves to the project's memory
          ...(origin === "chat" ? ["memory_edit"] : []),
        ]);
        const prompt = (script.body.messages as { content: string }[])[0]!
          .content;
        const bash = (id: string, command: string) => ({
          id,
          name: "bash",
          arguments: JSON.stringify({ command }),
        });
        script.toolRound([bash("read", "grep -n hello docs/x.md")]);
        script.end();
        const second = await waitScript(chat.scripted, 2);
        expect(second.body.messages).toContainEqual({
          role: "tool",
          tool_call_id: "read",
          content: "1:hello\n\nexit 0",
        });
        second.toolRound([bash("edit", "sed -i 's/hello/world/' docs/x.md")]);
        second.end();
        const third = await waitScript(chat.scripted, 3);
        const author = {
          kind: "agent",
          id: chat.agentId,
          name: "coder",
          sessionId,
          origin,
        };
        expect(chat.app.knowledge.read(chat.projectId, file.id)).toMatchObject({
          text: "world\n",
          revision: 2,
          lines: 1,
          author,
        });
        const edited = chat.app.sessions
          .messages(sessionId)
          .find((row) => row.toolCallId === "edit")!;
        expect(edited.status).toBe("done");
        expect(edited.content).toEndWith("wrote docs/x.md (rev 2, 1 lines)");
        expect(third.body.messages).toContainEqual({
          role: "tool",
          tool_call_id: "edit",
          content: edited.content,
        });
        expect((third.body.messages as { content: string }[])[0]!.content).toBe(
          prompt,
        );
        third.toolRound([bash("delete", "rm docs/x.md")]);
        third.end();
        const fourth = await waitScript(chat.scripted, 4);
        expect(
          chat.app.knowledge.store.byId(chat.projectId, file.id),
        ).toBeNull();
        expect(
          chat.app.knowledge.versions(chat.projectId, file.id)[0],
        ).toMatchObject({ revision: 3, deleted: true, author });
        expect(fourth.body.messages).toContainEqual({
          role: "tool",
          tool_call_id: "delete",
          content: "exit 0\ndeleted docs/x.md",
        });
        expect(
          (fourth.body.messages as { content: string }[])[0]!.content,
        ).toBe(prompt);
        fourth.reply("done");
        if (origin === "automation") {
          const phase = await waitScript(chat.scripted, 5);
          expect(
            (phase.body.tools as { function: { name: string } }[]).map(
              (tool) => tool.function.name,
            ),
          ).toEqual(["memory_edit"]);
          phase.toolRound([bash("forbidden", "touch forbidden.md")]);
          phase.end();
          const recovery = await waitScript(chat.scripted, 6);
          expect(chat.app.knowledge.counts(chat.projectId).files).toBe(0);
          expect(recovery.body.messages).toContainEqual({
            role: "tool",
            tool_call_id: "forbidden",
            content: "Error: only memory_edit is offered in the memory phase.",
          });
          recovery.toolRound([
            { id: "none", name: "memory_edit", arguments: '{"action":"none"}' },
          ]);
          recovery.end();
        }
        expect((await settleRun(chat, sessionId))?.status).toBe("done");
        const markdown = await chat.member.call(
          "GET",
          `/api/sessions/${sessionId}/markdown?tz=UTC`,
        );
        expect(markdown.status).toBe(200);
        const text = await markdown.text();
        expect(text).not.toContain("docs/x.md");
        expect(text).not.toContain("exit 0");
      } finally {
        await chat.app.shutdown();
        chat.app.db.close();
      }
    },
  );

  test("a nonzero bash exit stays a failed tool row with its write receipt", async () => {
    const chat = await chatApp();
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([
        {
          id: "failed",
          name: "bash",
          arguments: JSON.stringify({ command: "echo kept > kept.md; exit 1" }),
        },
      ]);
      script.end();
      const answer = await waitScript(chat.scripted, 2);
      const row = chat.app.sessions
        .messages(sessionId)
        .find((row) => row.toolCallId === "failed")!;
      expect(row.status).toBe("failed");
      expect(row.content).toBe("exit 1\nwrote kept.md (rev 1, 1 lines)");
      expect(
        chat.app.knowledge.store.byName(chat.projectId, "kept.md")?.text,
      ).toBe("kept\n");
      expect(answer.body.messages).toContainEqual({
        role: "tool",
        tool_call_id: "failed",
        content: row.content,
      });
      answer.reply("done");
      await settleRun(chat, sessionId);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });
});
