// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import { type ChatApp, chatApp, type Script, startChat } from "./chat.ts";
import { settled } from "./subagents.ts";

export const createProposal = (name = "proposed") => ({
  action: "create",
  name,
  instructions: "Check and report failures.",
  schedule: "0 9 * * *",
});

export async function draftApp() {
  const chat = await chatApp();
  chat.app.automationScheduler.stop();
  return chat;
}

export async function proposalRound(
  chat: ChatApp,
  script: Script,
  args: Record<string, unknown>[],
) {
  const next = chat.scripted.next();
  script.toolRound(
    args.map((fields, i) => ({
      id: `proposal-${i}`,
      name: "automation",
      arguments: JSON.stringify(fields),
    })),
  );
  script.end();
  return await next;
}

export async function proposals(
  chat: ChatApp,
  args: Record<string, unknown>[],
  projectId = chat.projectId,
  client = chat.member,
) {
  const { sessionId, script } = await startChat(
    chat,
    "propose tasks",
    client,
    projectId,
  );
  const answer = await proposalRound(chat, script, args);
  answer.reply("Waiting for confirmation.");
  await settled(chat, sessionId);
  const drafts = chat.app.automationDrafts.bySession(sessionId);
  expect(drafts).toHaveLength(args.length);
  const sequence = new Map(
    chat.app.sessions.messages(sessionId).map((row) => [row.id, row.seq]),
  );
  drafts.sort(
    (a, b) => sequence.get(a.messageId)! - sequence.get(b.messageId)!,
  );
  return { sessionId, drafts };
}

export const press = (
  chat: ChatApp,
  id: string,
  action = "confirm",
  client = chat.member,
) => client.call("POST", `/api/automation-drafts/${id}/${action}`);
