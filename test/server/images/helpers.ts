// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat app with a team project of two members and agents that read
// images, for the claim, queue and fork tests.

import { expect } from "bun:test";
import type { StagedImage } from "../../../src/shared/api/images.ts";
import { hashPassword } from "../../helpers/app.ts";
import { type ChatApp, chatApp, type Script } from "../../helpers/chat.ts";
import { png } from "../../helpers/images.ts";
import { createTeam } from "../../helpers/projects.ts";

export const MiB = 1024 * 1024;

const tiny = () => png(12, 8, (x) => [x < 6 ? 255 : 0, 0, 0, 255]);

export type ImageRow = {
  id: string;
  user_id: string;
  session_id: string | null;
  message_id: string | null;
  queued_id: string | null;
  position: number;
  bytes: number;
  created_at: number;
  expires_at: number | null;
  freed: number;
};

export async function imageApp() {
  const chat = await chatApp();
  const { app } = chat;
  const robinId = app.createUser({
    username: "robin",
    fullName: "Robin Roe",
    email: "robin@example.com",
    role: "member",
    passwordHash: await hashPassword("pw2"),
    mustChangePassword: false,
    now: app.now.value,
  }).id;
  const robin = app.client();
  await robin.login("robin", "pw2");
  const team = await createTeam(chat.admin, "ops", [chat.memberId, robinId]);
  // the agent's image flag, as a save from a catalog that lists them
  const reads = (agentId: string, on = true) =>
    app.db
      .query("update agents set images = ? where id = ?")
      .run(on ? 1 : 0, agentId);
  reads(chat.agentId);
  const stage = async (
    projectId: string,
    client = chat.member,
    name = "shot.png",
  ): Promise<StagedImage> => {
    const res = await client.call(
      "POST",
      `/api/projects/${projectId}/images?name=${encodeURIComponent(name)}`,
      {
        bytes: tiny(),
        headers: { "content-type": "application/octet-stream" },
      },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { image: StagedImage }).image;
  };
  const image = (id: string): ImageRow | null =>
    app.db
      .query<ImageRow, [string]>(
        `select id, user_id, session_id, message_id, queued_id, position,
           bytes, created_at, expires_at, data is null as freed
         from images where id = ?`,
      )
      .get(id);
  const ofSession = (sessionId: string): ImageRow[] =>
    app.db
      .query<ImageRow, [string]>(
        `select images.id, images.user_id, images.session_id, message_id,
           queued_id, position, bytes, images.created_at, expires_at,
           data is null as freed
         from images join messages on messages.id = images.message_id
         where images.session_id = ? order by messages.seq, position`,
      )
      .all(sessionId);
  // the stored size and age the budget reads, set by hand: the test
  // images are a few hundred bytes
  const size = (id: string, bytes: number, createdAt?: number) =>
    app.db
      .query(
        "update images set bytes = ?, created_at = coalesce(?, created_at) where id = ?",
      )
      .run(bytes, createdAt ?? null, id);
  const start = async (
    message: string,
    images: string[],
    projectId = chat.projectId,
    client = chat.member,
    agentId = chat.agentId,
  ) => {
    const pending = chat.scripted.next();
    const res = await client.call("POST", "/api/sessions", {
      body: { projectId, agentId, message, images },
    });
    if (res.status !== 201) {
      throw new Error(`start answered ${res.status}: ${await res.text()}`);
    }
    const detail = await res.json();
    return {
      detail,
      sessionId: detail.session.id as string,
      script: await pending,
    };
  };
  const send = (
    sessionId: string,
    body: Record<string, unknown>,
    client = chat.member,
  ) => client.call("POST", `/api/sessions/${sessionId}/messages`, { body });
  return {
    chat,
    app,
    robin,
    robinId,
    team,
    reads,
    stage,
    image,
    ofSession,
    size,
    start,
    send,
  };
}

export type ImageApp = Awaited<ReturnType<typeof imageApp>>;
export type { ChatApp };

// the user messages' text on the wire
export const userTexts = (script: Script) =>
  (script.body.messages as { role: string; content: string }[])
    .filter((message) => message.role === "user")
    .map((message) => message.content);
