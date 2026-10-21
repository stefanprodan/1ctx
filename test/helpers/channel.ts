// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import type { SessionDetail } from "../../src/shared/contracts/session.ts";
import { chatApp, FLASH, type Script } from "./chat.ts";
import { createTeam } from "./projects.ts";

export type WireMessage = {
  role: string;
  content: string;
  name?: string;
  tool_calls?: unknown[];
  reasoning_content?: string;
};

export const messagesOf = (script: Script) =>
  script.body.messages as WireMessage[];

export const localAt = (script: Script) =>
  messagesOf(script).findIndex(
    (message) =>
      message.role === "user" && message.content.startsWith("You talk to @"),
  );

export async function channelApp(options: Parameters<typeof chatApp>[0] = {}) {
  const chat = await chatApp(options);
  const project = await createTeam(chat.admin, "platform", [chat.memberId]);
  const channelId = chat.app.db
    .query<{ id: string }, [string]>(
      "select id from sessions where project_id = ? and origin = 'channel' and parent_session_id is null",
    )
    .get(project.id)!.id;
  const other = await chat.makeAgent({
    name: "reviewer",
    model: options.model ?? FLASH,
  });
  const post = (message: string, client = chat.member) =>
    client.call("POST", `/api/sessions/${channelId}/messages`, {
      body: { message },
    });
  const summon = async (
    name = "coder",
    text = "check this",
    client = chat.member,
  ) => {
    const count = chat.scripted.scripts.length + 1;
    const response = await post(`@${name} ${text}`, client);
    if (response.status !== 201) {
      throw new Error(
        `summon answered ${response.status}: ${await response.text()}`,
      );
    }
    const script = await chat.scripted.reached(count);
    const send = chat.app.runner.registry
      .inSession(channelId)
      .find((send) => send.policy.agentName === name)!;
    return { script, send };
  };
  const detail = async (): Promise<SessionDetail> => {
    const response = await chat.member.call(
      "GET",
      `/api/sessions/${channelId}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const tool = async (
    script: Script,
    command = "printf 'tool-%s' 'payload'",
  ) => {
    const count = chat.scripted.scripts.length + 1;
    script.toolRound([
      { id: "call", name: "bash", arguments: JSON.stringify({ command }) },
    ]);
    script.end();
    return chat.scripted.reached(count);
  };
  return { chat, project, channelId, other, post, summon, detail, tool };
}
