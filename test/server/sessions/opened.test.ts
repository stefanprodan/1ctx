// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { OpenedRecord } from "../../../src/server/knowledge/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { openedFileResponse } from "../../../src/server/sessions/opened.ts";
import type {
  ForkSessionResponse,
  OpenedFileResponse,
  SessionResponse,
} from "../../../src/shared/api/sessions.ts";
import { settleRun } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";

const opened: OpenedRecord[] = [
  {
    path: "/tmp/page.html",
    kind: "visual",
    language: null,
    bytes: 33,
    lines: 1,
    title: "Dashboard",
    text: "<title>Dashboard</title><p>ok</p>",
  },
  {
    path: "/tmp/notes.md",
    kind: "markdown",
    language: null,
    bytes: 14,
    lines: 3,
    title: null,
    text: "# Notes\n\nHello",
  },
  {
    path: "/tmp/code.ts",
    kind: "code",
    language: "typescript",
    bytes: 18,
    lines: 1,
    title: null,
    text: "const answer = 42;",
  },
  {
    path: "/tmp/plain",
    kind: "code",
    language: null,
    bytes: 5,
    lines: 1,
    title: null,
    text: "<raw>",
  },
];

function filePath(
  sessionId: string,
  messageId: string,
  index: string | number,
) {
  return `/api/sessions/${sessionId}/messages/${messageId}/files/${index}`;
}

async function detail(chat: ChatApp, sessionId: string) {
  const response = await chat.member.call("GET", `/api/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SessionResponse;
}

async function file(
  chat: ChatApp,
  sessionId: string,
  messageId: string,
  index: number,
): Promise<OpenedFileResponse> {
  const response = await chat.member.call(
    "GET",
    filePath(sessionId, messageId, index),
  );
  expect(response.status).toBe(200);
  return response.json();
}

describe("opened file rendering", () => {
  test("returns visual source, rendered Markdown, highlighted code and escaped text", () => {
    expect(openedFileResponse(opened[0]!)).toEqual({
      ...opened[0],
      html: opened[0]!.text,
      text: "",
    });
    const markdown = openedFileResponse(opened[1]!);
    expect(markdown.text).toBe(opened[1]!.text);
    expect(markdown.html).toContain('class="md-h1"');
    expect(markdown.html).toContain('class="md-p"');
    const code = openedFileResponse(opened[2]!);
    expect(code.text).toBe(opened[2]!.text);
    expect(code.html).toContain('class="hljs-keyword"');
    expect(openedFileResponse(opened[3]!)).toMatchObject({
      html: "&lt;raw&gt;",
      text: "<raw>",
    });
  });
});

describe("opened file storage and routes", () => {
  test.serial(
    "persists ordered metadata, serves copies, emits them, forks and cascades",
    async () => {
      const chat = await chatApp();
      const events: BusEvent[] = [];
      const off = subscribe((event) => events.push(event), silent);
      try {
        const started = await startChat(chat, "show the files");
        started.script.toolRound([
          {
            id: "open-files",
            name: "bash",
            arguments: JSON.stringify({
              command:
                "printf '<title>Dashboard</title><p>ok</p>' > /tmp/page.html; " +
                "printf '# Notes\\n\\nHello' > /tmp/notes.md; " +
                "printf 'const answer = 42;' > /tmp/code.ts; " +
                "printf '<raw>' > /tmp/plain; " +
                "open /tmp/page.html; open /tmp/notes.md; " +
                "open /tmp/code.ts; open /tmp/plain",
            }),
          },
        ]);
        started.script.end();
        const next = await waitScript(chat.scripted, 2);
        const providerTool = (
          next.body.messages as { role: string; content?: string }[]
        ).find((message) => message.role === "tool");
        expect(providerTool?.content).toContain(
          "opened /tmp/page.html for the user as a visual",
        );
        expect(providerTool?.content).toContain(
          "opened /tmp/notes.md for the user as Markdown, 3 lines",
        );
        expect(providerTool?.content).not.toContain("<title>Dashboard");
        next.reply("The files are open.");
        await settleRun(chat, started.sessionId);

        const row = chat.app.sessions
          .messages(started.sessionId)
          .find((message) => message.kind === "tool")!;
        expect(row.files?.map((item) => item.path)).toEqual(
          opened.map((item) => item.path),
        );
        expect(JSON.stringify(row.files)).not.toContain("<raw>");
        expect(chat.app.sessions.openedFile(row.id, 2)).toEqual(opened[2]);
        expect(chat.app.sessions.openedFile(row.id, 4)).toBeNull();

        const body = await detail(chat, started.sessionId);
        const wire = body.messages.find((message) => message.id === row.id)!;
        expect(wire.files).toEqual(row.files);
        expect(wire.content).toBe("");

        const visual = await file(chat, started.sessionId, row.id, 0);
        expect(visual).toMatchObject({
          kind: "visual",
          title: "Dashboard",
          html: "<title>Dashboard</title><p>ok</p>",
          text: "",
        });
        const markdown = await file(chat, started.sessionId, row.id, 1);
        expect(markdown.html).toContain('class="md-h1"');
        expect(markdown.text).toBe("# Notes\n\nHello");
        const code = await file(chat, started.sessionId, row.id, 2);
        expect(code.html).toContain('class="hljs-keyword"');
        expect(code.text).toBe("const answer = 42;");
        expect(await file(chat, started.sessionId, row.id, 3)).toMatchObject({
          html: "&lt;raw&gt;",
          text: "<raw>",
        });

        const changed = events.filter(
          (event) =>
            event.type === "session.changed" &&
            event.data.session.id === started.sessionId,
        );
        const toolEvent = changed.find(
          (event) =>
            event.type === "session.changed" &&
            event.data.messages.some(
              (message) => message.id === row.id && message.files !== null,
            ),
        );
        expect(toolEvent).toBeDefined();
        expect(JSON.stringify(toolEvent)).not.toContain("<raw>");
        expect(
          (
            toolEvent as Extract<BusEvent, { type: "session.changed" }>
          ).data.messages.find((message) => message.id === row.id)?.files,
        ).toEqual(row.files);

        const answer = body.messages.find(
          (message) => message.slot === "answer",
        )!;
        const forkResponse = await chat.member.call(
          "POST",
          `/api/sessions/${started.sessionId}/fork`,
          { body: { messageId: answer.id, agentId: chat.agentId } },
        );
        expect(forkResponse.status).toBe(201);
        const forked = (await forkResponse.json()) as ForkSessionResponse;
        const copied = forked.messages.find(
          (message) => message.kind === "tool",
        )!;
        expect(copied.files).toEqual(row.files);
        expect(chat.app.sessions.openedFile(copied.id, 3)?.text).toBe("<raw>");
        expect(
          (await file(chat, forked.session.id, copied.id, 0)).html,
        ).toContain("Dashboard");

        const outsider = chat.app.createUser({
          username: "outsider",
          fullName: "Outsider",
          email: "outsider@example.com",
          role: "member",
          passwordHash: chat.app.users.byId(chat.memberId)!.passwordHash,
          mustChangePassword: false,
          now: chat.app.now.value,
        });
        const outsiderClient = chat.app.client();
        expect(
          (await outsiderClient.login(outsider.username, "pw")).status,
        ).toBe(200);
        expect(
          (
            await outsiderClient.call(
              "GET",
              filePath(started.sessionId, row.id, 0),
            )
          ).status,
        ).toBe(404);

        const replacement = chat.scripted.next();
        const regenerated = await chat.member.call(
          "POST",
          `/api/sessions/${forked.session.id}/regenerate`,
        );
        expect(regenerated.status).toBe(201);
        expect(
          chat.app.db
            .query<{ n: number }, [string]>(
              "select count(*) as n from opened_files where message_id = ?",
            )
            .get(copied.id)?.n,
        ).toBe(0);
        (await replacement).reply("Regenerated.");
        await settleRun(chat, forked.session.id);

        expect(
          (
            await chat.member.call(
              "GET",
              filePath(started.sessionId, body.messages[0]!.id, 0),
            )
          ).status,
        ).toBe(404);
        const bad = await chat.member.call(
          "GET",
          filePath(started.sessionId, row.id, "-1"),
        );
        expect(bad.status).toBe(400);
        expect(await bad.json()).toEqual({
          error: "index must be a non-negative integer",
        });
        expect(
          (
            await chat.member.call(
              "GET",
              filePath(started.sessionId, row.id, 99),
            )
          ).status,
        ).toBe(404);

        expect(
          (
            await chat.member.call(
              "DELETE",
              `/api/sessions/${started.sessionId}`,
            )
          ).status,
        ).toBe(200);
        expect(
          chat.app.db
            .query<{ n: number }, [string]>(
              "select count(*) as n from opened_files where message_id = ?",
            )
            .get(row.id)?.n,
        ).toBe(0);
      } finally {
        off();
        await chat.app.shutdown();
      }
    },
  );

  test("a late tool finish cannot insert opened copies", async () => {
    const chat = await chatApp();
    try {
      const started = await startChat(chat);
      started.script.reply("done");
      await settleRun(chat, started.sessionId);
      const send = chat.app.sessions.lastSend(started.sessionId)!;
      const [row] = chat.app.sessions.addToolRows([
        {
          sessionId: started.sessionId,
          sendId: send.id,
          round: 2,
          toolCallId: "late",
          toolName: "bash",
          now: chat.app.now.value,
        },
      ]);
      chat.app.sessions.finishTool(row!.id, {
        content: "stopped",
        status: "stopped",
        error: null,
        finishedAt: chat.app.now.value,
      });
      expect(
        chat.app.sessions.finishTool(row!.id, {
          content: "late",
          status: "done",
          error: null,
          finishedAt: chat.app.now.value,
          opened,
        }),
      ).toBeNull();
      expect(chat.app.sessions.openedFile(row!.id, 0)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });
});
