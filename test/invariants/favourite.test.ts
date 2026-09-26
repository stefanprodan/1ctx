// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A new chat starts on the user's favourite agent, else the default an
// admin marked, else the first created. Deleting an agent hands either
// on with no write.

import { describe, expect, test } from "bun:test";
import type { FavouriteAgentResponse } from "../../src/shared/api/agents.ts";
import type {
  DirectoryAgentResponse,
  DirectoryUserResponse,
} from "../../src/shared/api/directory.ts";
import type { ProjectAgentsResponse } from "../../src/shared/api/sessions.ts";
import { type ChatApp, chatApp, FLASH } from "../helpers/chat.ts";

// three agents a minute apart, coder the oldest
async function three(): Promise<ChatApp & { ops: string; writer: string }> {
  const chat = await chatApp();
  chat.app.now.value += 60_000;
  const ops = await chat.makeAgent({ name: "ops", model: FLASH });
  chat.app.now.value += 60_000;
  const writer = await chat.makeAgent({ name: "writer", model: FLASH });
  return { ...chat, ops, writer };
}

async function starting(chat: ChatApp): Promise<string | null> {
  const res = await chat.member.call(
    "GET",
    `/api/projects/${chat.projectId}/agents`,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as ProjectAgentsResponse).favourite;
}

async function defaults(chat: ChatApp): Promise<string[]> {
  const { agents } = await (await chat.admin.call("GET", "/api/agents")).json();
  return agents
    .filter((a: { default: boolean }) => a.default)
    .map((a: { name: string }) => a.name);
}

const mark = (chat: ChatApp, id: string, on: boolean) =>
  chat.admin.call("PATCH", `/api/agents/${id}`, {
    body: {
      name: chat.app.agents.byId(id)!.name,
      providerId: chat.providerId,
      model: FLASH,
      thinking: null,
      effort: null,
      servers: [],
      mcpMode: "auto",
      default: on,
    },
  });

const pick = (chat: ChatApp, agentId: string | null) =>
  chat.member.call("PUT", "/api/profile/agent", { body: { agentId } });

describe("the agent a new chat starts on", () => {
  test("is the first created until an admin marks another", async () => {
    const chat = await three();
    expect(await starting(chat)).toBe(chat.agentId);
    expect(await defaults(chat)).toEqual(["coder"]);

    expect((await mark(chat, chat.writer, true)).status).toBe(200);
    expect(await starting(chat)).toBe(chat.writer);
    expect(await defaults(chat)).toEqual(["writer"]);

    // the mark moves, never doubles
    expect((await mark(chat, chat.ops, true)).status).toBe(200);
    expect(await defaults(chat)).toEqual(["ops"]);

    // off on the default goes back to the oldest
    expect((await mark(chat, chat.ops, false)).status).toBe(200);
    expect(await defaults(chat)).toEqual(["coder"]);
    // off on an agent that is not the default leaves the mark
    await mark(chat, chat.writer, true);
    expect((await mark(chat, chat.ops, false)).status).toBe(200);
    expect(await defaults(chat)).toEqual(["writer"]);
    await chat.app.shutdown();
  });

  test("a save that leaves default out keeps the mark", async () => {
    const chat = await three();
    await mark(chat, chat.writer, true);
    const body = {
      name: "writer",
      providerId: chat.providerId,
      model: FLASH,
      thinking: null,
      effort: null,
      servers: [],
      mcpMode: "auto",
      prompt: "Write well.",
    };
    const res = await chat.admin.call("PATCH", `/api/agents/${chat.writer}`, {
      body,
    });
    expect(res.status).toBe(200);
    expect(await defaults(chat)).toEqual(["writer"]);
    await chat.app.shutdown();
  });

  test("an agent made as the default takes the mark", async () => {
    const chat = await chatApp();
    const res = await chat.admin.call("POST", "/api/agents", {
      body: {
        name: "ops",
        providerId: chat.providerId,
        model: FLASH,
        thinking: null,
        effort: null,
        servers: [],
        mcpMode: "auto",
        default: true,
      },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).agent.default).toBe(true);
    expect(await defaults(chat)).toEqual(["ops"]);
    await chat.app.shutdown();
  });

  test("is the user's favourite, then the default once it is gone", async () => {
    const chat = await three();
    await mark(chat, chat.writer, true);
    const res = await pick(chat, chat.ops);
    expect(res.status).toBe(200);
    expect((await res.json()) as FavouriteAgentResponse).toEqual({
      agentId: chat.ops,
      defaultId: chat.writer,
      agents: [
        { id: chat.agentId, name: "coder", avatar: "bot" },
        { id: chat.ops, name: "ops", avatar: "bot" },
        { id: chat.writer, name: "writer", avatar: "bot" },
      ],
    });
    expect(await starting(chat)).toBe(chat.ops);
    // another user follows the default
    const theirs = await chat.admin.call(
      "GET",
      `/api/projects/${chat.app.projects.personal(chat.adminId)!.id}/agents`,
    );
    expect(((await theirs.json()) as ProjectAgentsResponse).favourite).toBe(
      chat.writer,
    );

    // a deleted favourite clears, so the default answers
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.ops}`)).status,
    ).toBe(200);
    expect(chat.app.users.byId(chat.memberId)!.agentId).toBeNull();
    expect(await starting(chat)).toBe(chat.writer);

    // a deleted default hands on to the oldest left
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.writer}`)).status,
    ).toBe(200);
    expect(await starting(chat)).toBe(chat.agentId);
    expect(await defaults(chat)).toEqual(["coder"]);
    await chat.app.shutdown();
  });

  test("null follows the default again, an unknown agent is a 400", async () => {
    const chat = await three();
    await pick(chat, chat.ops);
    const cleared = await pick(chat, null);
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as FavouriteAgentResponse).agentId).toBe(
      null,
    );
    expect(await starting(chat)).toBe(chat.agentId);
    for (const body of [
      { agentId: "nope" },
      { agentId: "" },
      { agentId: 3 },
      {},
      { agentId: null, extra: 1 },
    ]) {
      const res = await chat.member.call("PUT", "/api/profile/agent", {
        body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    await chat.app.shutdown();
  });

  test("with no agents there is nothing to start on", async () => {
    const chat = await chatApp();
    // the one agent has no chats yet
    expect(
      (await chat.admin.call("DELETE", `/api/agents/${chat.agentId}`)).status,
    ).toBe(200);
    expect(await starting(chat)).toBeNull();
    const res = await chat.member.call("GET", "/api/profile/agent");
    expect(await res.json()).toEqual({
      agentId: null,
      defaultId: null,
      agents: [],
    });
    await chat.app.shutdown();
  });
});

describe("the people pages", () => {
  test("show the favourite a user picked, never the default", async () => {
    const chat = await three();
    const person = async () =>
      (await (
        await chat.admin.call("GET", "/api/directory/users/casey")
      ).json()) as DirectoryUserResponse;
    const page = async (name: string) =>
      (await (
        await chat.member.call("GET", `/api/directory/agents/${name}`)
      ).json()) as DirectoryAgentResponse;

    expect((await person()).favourite).toBeNull();
    expect((await page("coder")).favourite).toBe(false);
    expect((await page("coder")).agent.default).toBe(true);

    await pick(chat, chat.ops);
    expect((await person()).favourite).toBe("ops");
    expect((await page("ops")).favourite).toBe(true);
    expect((await page("coder")).favourite).toBe(false);
    await chat.app.shutdown();
  });
});
