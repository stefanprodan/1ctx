// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The chat a task was made in names its title only to a reader the
// chat's own route lets open it, on a read and on every move's answer;
// an agent's read carries no title.

import { expect, test } from "bun:test";
import type { ExternalTaskResponse } from "../../../src/shared/api/external-tasks.ts";
import { hashPassword } from "../../helpers/app.ts";
import { chatApp, startChat } from "../../helpers/chat.ts";
import { createTeam } from "../../helpers/projects.ts";
import { settle } from "../../helpers/tool-loop.ts";

test("a task's chat title reaches only a reader who may open the chat", async () => {
  const chat = await chatApp();
  chat.app.automationScheduler.stop();
  try {
    const dana = chat.app.createUser({
      username: "dana",
      fullName: "Dana",
      email: "dana@example.com",
      role: "member",
      passwordHash: await hashPassword("pw"),
      mustChangePassword: false,
      now: chat.app.now.value,
    });
    const other = chat.app.client();
    expect((await other.login("dana", "pw")).status).toBe(200);
    const team = await createTeam(chat.admin, "team", [chat.memberId, dana.id]);

    const started = async (message: string, projectId: string) => {
      const { script, sessionId } = await startChat(
        chat,
        message,
        chat.member,
        projectId,
      );
      script.reply("done");
      await settle(chat);
      return sessionId;
    };
    const teamChat = await started("Plan the sweep", team.id);
    // casey's personal chat, which dana cannot open
    const ownChat = await started("Private notes", chat.projectId);
    const made = (chatId: string) =>
      chat.app.externalTasks.create(
        chat.memberId,
        team.id,
        { title: "Port it", text: "Port the parser.", fileIds: [] },
        chatId,
      ).task.task.id;
    const shared = made(teamChat);
    const hidden = made(ownChat);

    const read = async (client: typeof other, id: string) => {
      const response = await client.call("GET", `/api/external-tasks/${id}`);
      expect(response.status).toBe(200);
      return ((await response.json()) as ExternalTaskResponse).task;
    };
    // the chat route's own answer for each reader
    const opens = async (client: typeof other, id: string) =>
      (await client.call("GET", `/api/sessions/${id}`)).status;

    expect(await opens(other, teamChat)).toBe(200);
    expect(await read(other, shared)).toMatchObject({
      chatId: teamChat,
      chatTitle: "Plan the sweep",
    });

    expect(await opens(other, ownChat)).toBe(404);
    const unseen = await read(other, hidden);
    expect(unseen.chatTitle).toBeNull();
    expect(JSON.stringify(unseen)).not.toContain("Private notes");
    expect(await opens(chat.member, ownChat)).toBe(200);
    expect((await read(chat.member, hidden)).chatTitle).toBe("Private notes");

    // a move answers the detail its reader may see
    const dropped = await other.call(
      "POST",
      `/api/external-tasks/${hidden}/drop`,
      { body: { state: "open" } },
    );
    expect(dropped.status).toBe(200);
    const answer = await dropped.text();
    expect(answer).not.toContain("Private notes");
    expect(JSON.parse(answer).task.chatTitle).toBeNull();
    const reopened = await chat.member.call(
      "POST",
      `/api/external-tasks/${hidden}/reopen`,
      { body: { state: "dropped", text: "Again." } },
    );
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).task.chatTitle).toBe("Private notes");

    for (const [client, title] of [
      [other, null],
      [chat.member, "Private notes"],
    ] as const) {
      const revision = (await read(client, hidden)).task.editRevision;
      const edited = await client.call(
        "PATCH",
        `/api/external-tasks/${hidden}`,
        { body: { editRevision: revision, title: `Port it ${revision}` } },
      );
      expect(edited.status).toBe(200);
      expect((await edited.json()).task.chatTitle).toBe(title);
    }

    // an agent's or a chat tool's read has no viewer and no title
    expect(
      chat.app.externalTasks.show(shared, null)!.task.chatTitle,
    ).toBeNull();
  } finally {
    await chat.app.shutdown();
  }
});
