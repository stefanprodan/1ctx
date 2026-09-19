// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "bun:test";
import { transact } from "../../../src/server/db/index.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { StagedUpload } from "../../../src/shared/contracts/knowledge.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { ORIGIN } from "../../helpers/app.ts";
import { settleRun } from "../../helpers/automations.ts";
import { type ChatApp, type Script, waitScript } from "../../helpers/chat.ts";

export async function stage(
  chat: ChatApp,
  name: string,
  body: BodyInit = "attached text",
  client = chat.member,
  projectId = chat.projectId,
): Promise<StagedUpload & { id: string }> {
  const query = new URLSearchParams({
    name,
    attempt: crypto.randomUUID(),
  });
  const response = await chat.app.handle(
    new Request(`${ORIGIN}/api/projects/${projectId}/uploads?${query}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: client.cookie!,
        "content-type": "application/octet-stream",
      },
      body,
    }),
    "127.0.0.1",
  );
  expect(response?.status).toBe(200);
  const item = (await response!.json()) as StagedUpload;
  expect(item.id).toEqual(expect.any(String));
  return item as StagedUpload & { id: string };
}

export function stageFiles(
  chat: ChatApp,
  name: string,
  files: { name: string; text: string }[],
) {
  const item = transact(chat.app.db, () => ({
    result: chat.app.knowledge.uploads.stage(
      chat.memberId,
      chat.projectId,
      {
        attempt: crypto.randomUUID(),
        name,
        archive: true,
        folder: "",
        files,
        result: {
          added: files.length,
          replaced: 0,
          unchanged: 0,
          renamed: 0,
          saved: files.map((file) => file.name),
          skipped: [],
          skippedTotal: 0,
        },
      },
      DEFAULT_LIMITS,
      chat.app.now.value,
    ),
  }));
  expect(item.id).toEqual(expect.any(String));
  return item as StagedUpload & { id: string };
}

export async function start(
  chat: ChatApp,
  uploads: string[] = [],
  message = "read these files",
) {
  const count = chat.scripted.scripts.length + 1;
  const response = await chat.member.call("POST", "/api/sessions", {
    body: {
      projectId: chat.projectId,
      agentId: chat.agentId,
      message,
      uploads,
    },
  });
  expect(response.status).toBe(201);
  const detail: SessionDetail = await response.json();
  return {
    detail,
    sessionId: detail.session.id,
    script: await waitScript(chat.scripted, count),
  };
}

export async function send(
  chat: ChatApp,
  sessionId: string,
  uploads: string[] = [],
  message = "read them again",
) {
  const count = chat.scripted.scripts.length + 1;
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message, uploads } },
  );
  expect(response.status).toBe(201);
  return {
    detail: (await response.json()) as SessionDetail,
    script: await waitScript(chat.scripted, count),
  };
}

export async function finish(
  chat: ChatApp,
  sessionId: string,
  script: Script,
  text = "done",
) {
  script.reply(text);
  await settleRun(chat, sessionId);
}

export function messages(script: Script) {
  return script.body.messages as {
    role: string;
    content: string | null;
    name?: string;
  }[];
}

export function staged(chat: ChatApp) {
  return chat.app.knowledge.uploads.list(
    chat.memberId,
    chat.projectId,
    chat.app.now.value,
  );
}

export function files(chat: ChatApp, sessionId: string) {
  return chat.app.knowledge.uploads
    .read(sessionId)
    .entries.map(({ name, text }) => ({ name, text }));
}

export async function close(chat: ChatApp) {
  await chat.app.shutdown();
  chat.app.db.close();
}
