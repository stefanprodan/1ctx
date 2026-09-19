// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { SUMMARY_LEAD } from "../../../src/server/runner/context.ts";
import {
  UPLOADS_SUMMARY_LINE,
  uploadsBlock,
} from "../../../src/shared/uploads.ts";
import { createAutomation, startRun } from "../../helpers/automations.ts";
import { type ChatApp, chatApp, waitScript } from "../../helpers/chat.ts";
import {
  close,
  files,
  finish,
  messages,
  send,
  stage,
  staged,
  start,
} from "./uploads-helpers.ts";

async function compact(chat: ChatApp, sessionId: string, text: string) {
  const count = chat.scripted.scripts.length + 1;
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/compact`,
  );
  expect(response.status).toBe(200);
  const script = await waitScript(chat.scripted, count);
  await finish(chat, sessionId, script, text);
  return script;
}

describe("uploads in provider context", () => {
  test("a user block is byte-identical on the next send and bash reads the claimed bytes", async () => {
    const chat = await chatApp();
    try {
      const item = await stage(chat, "Readme.md", "only in the uploaded file");
      const started = await start(chat, [item.id], "inspect this");
      const record = started.detail.messages[0]!.uploads!;
      const first = messages(started.script).find(
        (row) => row.role === "user",
      )!;
      expect(first.content).toBe(`inspect this\n\n${uploadsBlock(record)}`);
      expect(JSON.stringify(started.script.body)).not.toContain(
        "only in the uploaded file",
      );
      started.script.toolRound([
        {
          id: "read-upload",
          name: "bash",
          arguments: JSON.stringify({ command: "cat /uploads/readme.md" }),
        },
      ]);
      started.script.end();
      const answer = await waitScript(chat.scripted, 2);
      expect(
        messages(answer).find((row) => row.role === "tool")?.content,
      ).toContain("only in the uploaded file");
      await finish(chat, started.sessionId, answer);

      const replacement = await stage(chat, "Readme.md", "replacement bytes");
      const next = await send(
        chat,
        started.sessionId,
        [replacement.id],
        "inspect the replacement",
      );
      const users = messages(next.script).filter((row) => row.role === "user");
      expect(users[0]).toEqual(first);
      expect(users[1]?.content).toBe(
        `inspect the replacement\n\n${uploadsBlock(
          next.detail.messages.filter((row) => row.kind === "user").at(-1)!
            .uploads!,
        )}`,
      );
      expect(files(chat, started.sessionId)).toEqual([
        { name: "readme.md", text: "replacement bytes" },
      ]);
      await finish(chat, started.sessionId, next.script);
    } finally {
      await close(chat);
    }
  });

  test("a summary before the first upload stays unchanged and later summaries carry the earlier-file line", async () => {
    const chat = await chatApp();
    try {
      const started = await start(chat);
      await finish(chat, started.sessionId, started.script);
      await compact(chat, started.sessionId, "summary before files");
      const baseline = await send(chat, started.sessionId, [], "continue");
      const summary = messages(baseline.script)[1]!;
      expect(summary).toEqual({
        role: "user",
        content: `${SUMMARY_LEAD}\n\nsummary before files`,
      });
      await finish(chat, started.sessionId, baseline.script);

      const item = await stage(chat, "later.md", "later upload");
      const attached = await send(chat, started.sessionId, [item.id]);
      expect(messages(attached.script)[1]).toEqual(summary);
      expect(messages(attached.script)[1]!.content).not.toContain(
        UPLOADS_SUMMARY_LINE,
      );
      await finish(chat, started.sessionId, attached.script);
      const tree = chat.app.knowledge.uploads.read(started.sessionId);
      const second = await compact(
        chat,
        started.sessionId,
        "summary after files",
      );
      expect(messages(second)[1]).toEqual(summary);
      expect(chat.app.knowledge.uploads.read(started.sessionId)).toEqual(tree);
      const next = await send(chat, started.sessionId);
      expect(messages(next.script)[1]).toEqual({
        role: "user",
        content: `${SUMMARY_LEAD}\n\nsummary after files\n\n${UPLOADS_SUMMARY_LINE}`,
      });
      expect(JSON.stringify(messages(next.script))).not.toContain("<uploads>");
      await finish(chat, started.sessionId, next.script);
      await compact(chat, started.sessionId, "summary with no newer upload");
      const third = await send(chat, started.sessionId);
      expect(messages(third.script)[1]?.content).toBe(
        `${SUMMARY_LEAD}\n\nsummary with no newer upload\n\n${UPLOADS_SUMMARY_LINE}`,
      );
      await finish(chat, started.sessionId, third.script);
    } finally {
      await close(chat);
    }
  });

  test("regenerate and compact preserve the tree, other chats see nothing, and delete cascades", async () => {
    const chat = await chatApp();
    try {
      const item = await stage(chat, "owned.md", "belongs to one chat");
      const started = await start(chat, [item.id]);
      await finish(chat, started.sessionId, started.script);
      const tree = chat.app.knowledge.uploads.read(started.sessionId);
      const user = chat.app.sessions.messages(started.sessionId)[0]!;
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${started.sessionId}/regenerate`,
          )
        ).status,
      ).toBe(201);
      const regenerated = await waitScript(chat.scripted, 2);
      expect(messages(regenerated)[1]?.content).toBe(
        `${user.content}\n\n${uploadsBlock(user.uploads!)}`,
      );
      expect(chat.app.knowledge.uploads.read(started.sessionId)).toEqual(tree);
      await finish(chat, started.sessionId, regenerated);
      await compact(chat, started.sessionId, "the files remain");
      expect(chat.app.knowledge.uploads.read(started.sessionId)).toEqual(tree);
      expect(chat.app.sessions.messages(started.sessionId)[0]?.uploads).toEqual(
        user.uploads,
      );

      const separate = await start(chat);
      expect(files(chat, separate.sessionId)).toEqual([]);
      expect(JSON.stringify(messages(separate.script))).not.toContain(
        "<uploads>",
      );
      separate.script.toolRound([
        {
          id: "empty-uploads",
          name: "bash",
          arguments: JSON.stringify({
            command: "test -d /uploads && ls -A /uploads && echo empty-tree",
          }),
        },
      ]);
      separate.script.end();
      const answer = await waitScript(chat.scripted, 5);
      const result = messages(answer).find((row) => row.role === "tool")!;
      expect(result.content).toContain("empty-tree");
      expect(result.content).not.toContain("owned.md");
      await finish(chat, separate.sessionId, answer);
      expect(
        (await chat.member.call("DELETE", `/api/sessions/${started.sessionId}`))
          .status,
      ).toBe(200);
      expect(
        chat.app.db
          .query("select * from session_uploads where session_id = ?")
          .all(started.sessionId),
      ).toEqual([]);
      expect(
        chat.app.db
          .query("select * from session_upload_files where session_id = ?")
          .all(started.sessionId),
      ).toEqual([]);
      expect(chat.app.sessions.byId(separate.sessionId)).not.toBeNull();
      expect(chat.app.db.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      await close(chat);
    }
  });

  test("a run has no records or prompt block and its bash mount is empty", async () => {
    const chat = await chatApp();
    try {
      const claimed = await stage(chat, "chat-only.md", "chat bytes");
      const source = await start(chat, [claimed.id]);
      await finish(chat, source.sessionId, source.script);
      const pending = await stage(chat, "still-staged.md", "draft bytes");
      const automation = await createAutomation(chat);
      const run = await startRun(chat, automation.id);
      expect(JSON.stringify(messages(run.main))).not.toContain("<uploads>");
      expect(JSON.stringify(messages(run.main))).not.toContain(
        UPLOADS_SUMMARY_LINE,
      );
      expect(files(chat, run.sessionId)).toEqual([]);
      run.main.toolRound([
        {
          id: "run-files",
          name: "bash",
          arguments: JSON.stringify({
            command: "test -d /uploads && ls -A /uploads && echo run-empty",
          }),
        },
      ]);
      run.main.end();
      const answer = await waitScript(chat.scripted, 3);
      const result = messages(answer).find((row) => row.role === "tool")!;
      expect(result.content).toContain("run-empty");
      expect(result.content).not.toContain("chat-only.md");
      expect(result.content).not.toContain("still-staged.md");
      await finish(chat, run.sessionId, answer);
      expect(
        chat.app.sessions
          .messages(run.sessionId)
          .every((row) => row.uploads === null),
      ).toBeTrue();
      expect(staged(chat)).toEqual([pending]);
      expect(files(chat, source.sessionId)).toEqual([
        { name: "chat-only.md", text: "chat bytes" },
      ]);
    } finally {
      await close(chat);
    }
  });
});
