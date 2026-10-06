// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat app whose agent may delegate, and the scripts that tell a
// subagent's requests from its parent's.

import { SUBAGENT_LINE } from "../../src/server/runner/prompt.ts";
import type { Message } from "../../src/shared/contracts/session.ts";
import { type ChatApp, chatApp, type Script, tick } from "./chat.ts";

export async function subagentApp(
  options: Parameters<typeof chatApp>[0] = {},
): Promise<ChatApp> {
  const chat = await chatApp(options);
  chat.app.automationScheduler.stop();
  allowSubagents(chat, chat.agentId);
  return chat;
}

export function allowSubagents(chat: ChatApp, agentId: string, on = true) {
  chat.app.db
    .query("update agents set subagents = ? where id = ?")
    .run(on ? 1 : 0, agentId);
}

export const delegateCall = (
  id: string,
  task: string,
  description = "look around",
) => ({
  id,
  name: "delegate",
  arguments: JSON.stringify({ description, task }),
});

export const bashCall = (id: string, command: string) => ({
  id,
  name: "bash",
  arguments: JSON.stringify({ command }),
});

type Wire = { role: string; content: string; name?: string };

export const wire = (script: Script) => script.body.messages as Wire[];
export const system = (script: Script) => wire(script)[0]!.content;
export const isChild = (script: Script) =>
  system(script).includes(SUBAGENT_LINE);
export const toolNames = (script: Script) =>
  ((script.body.tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );
// the last tool result the request carries
export const lastResult = (script: Script) =>
  wire(script).findLast((message) => message.role === "tool")?.content ?? "";

// the scripts that arrived, past the first `from`, until count are in
export async function scriptsFrom(
  chat: ChatApp,
  count: number,
  tries = 800,
): Promise<Script[]> {
  for (let i = 0; i < tries; i++) {
    if (chat.scripted.scripts.length >= count) return chat.scripted.scripts;
    await tick();
  }
  throw new Error(
    `only ${chat.scripted.scripts.length} chat requests, wanted ${count}`,
  );
}

// the child script whose task holds the word
export const childFor = (scripts: Script[], word: string): Script => {
  const found = scripts.find(
    (script) =>
      isChild(script) &&
      wire(script).some(
        (message) => message.role === "user" && message.content.includes(word),
      ),
  );
  if (found === undefined) throw new Error(`no child script for ${word}`);
  return found;
};

export async function settled(chat: ChatApp, sessionId: string) {
  for (let i = 0; i < 800; i++) {
    if (
      chat.app.sessions.byId(sessionId)?.status !== "running" &&
      chat.app.runner.registry.get(sessionId) === null
    ) {
      return chat.app.sessions.byId(sessionId)!;
    }
    await tick();
  }
  throw new Error("the send did not settle");
}

// the subagent sessions under a root, oldest first
export const childrenOf = (chat: ChatApp, rootId: string): string[] =>
  chat.app.db
    .query<{ id: string }, [string]>(
      "select id from sessions where parent_session_id = ? order by rowid",
    )
    .all(rootId)
    .map((row) => row.id);

export const delegateRows = (chat: ChatApp, rootId: string): Message[] =>
  chat.app.sessions
    .messages(rootId)
    .filter((row) => row.kind === "tool" && row.toolName === "delegate");
