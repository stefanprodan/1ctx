// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The search queue through compose's real wiring: the busy answer on
// the page and over /mcp, many /mcp searches on one key, and access
// checked again once a queued search has run.

import { describe, expect, test } from "bun:test";
import {
  SEARCH_RETRY_S,
  SEARCH_WAITERS,
} from "../../src/server/lib/search-queue.ts";
import { createKey } from "../helpers/access-keys.ts";
import { type ChatApp, chatApp } from "../helpers/chat.ts";
import { createTeam } from "../helpers/projects.ts";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
};

type ToolResult = { content: { text: string }[]; isError?: boolean };

const BUSY = `search busy, retry in ${SEARCH_RETRY_S} s`;

// one tools/call over the real endpoint; the HTTP answer is always 200
async function tool(
  chat: ChatApp,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const response = await chat.app.client().call("POST", "/mcp", {
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, _meta: META },
    }),
    headers: {
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()).result;
}

const text = (result: ToolResult) =>
  result.content.map((part) => part.text).join("\n");

// the queue held by a scan that runs until released
function hold(chat: ChatApp) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = chat.app.searches.run({ from: "mcp" }, () => gate);
  return {
    release: async () => {
      release();
      await running;
    },
  };
}

const searchPath = (projectId: string, q: string) =>
  `/api/projects/${projectId}/knowledge/search?q=${encodeURIComponent(q)}`;

async function createFile(
  chat: ChatApp,
  projectId: string,
  name: string,
  body: string,
) {
  const response = await chat.member.call(
    "POST",
    `/api/projects/${projectId}/knowledge`,
    { body: { name, text: body } },
  );
  expect(response.status).toBe(201);
}

describe("the composed search queue", () => {
  test("a full queue answers the page 429 with Retry-After and /mcp an error result", async () => {
    const chat = await chatApp();
    try {
      await createFile(chat, chat.projectId, "a.md", "a topic\n");
      const key = await createKey(chat.member, { name: "busy", scope: "read" });
      const held = hold(chat);
      const waiting = Array.from({ length: SEARCH_WAITERS }, () =>
        chat.app.searches.run({ from: "mcp" }, async () => {}),
      );
      expect(chat.app.searches.waiting()).toBe(SEARCH_WAITERS);

      const page = await chat.member.call(
        "GET",
        searchPath(chat.projectId, "topic"),
      );
      expect(page.status).toBe(429);
      expect(page.headers.get("retry-after")).toBe(String(SEARCH_RETRY_S));
      expect(await page.json()).toEqual({ error: BUSY });

      const files = await tool(chat, key.token, "knowledge", {
        action: "search",
        projectId: chat.projectId,
        q: "topic",
      });
      expect(files.isError).toBe(true);
      expect(text(files)).toBe(BUSY);
      const sessions = await tool(chat, key.token, "sessions", {
        action: "search",
        projectId: chat.projectId,
        q: "topic",
      });
      expect(sessions.isError).toBe(true);
      expect(text(sessions)).toBe(BUSY);

      await held.release();
      await Promise.all(waiting);
      const later = await chat.member.call(
        "GET",
        searchPath(chat.projectId, "topic"),
      );
      expect(later.status).toBe(200);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("twenty /mcp searches on one key all answer", async () => {
    const chat = await chatApp();
    try {
      await createFile(chat, chat.projectId, "a.md", "a topic\n");
      const key = await createKey(chat.member, { name: "many", scope: "read" });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          tool(chat, key.token, "knowledge", {
            action: "search",
            projectId: chat.projectId,
            q: "topic",
          }),
        ),
      );
      for (const result of results) {
        expect(result.isError).toBeUndefined();
        expect(text(result)).toContain('"name":"a.md"');
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a member removed while queued gets no result", async () => {
    const chat = await chatApp();
    try {
      const team = await createTeam(chat.admin, "alpha", [chat.memberId]);
      await createFile(chat, team.id, "secret.md", "a topic\n");
      const key = await createKey(chat.member, { name: "team", scope: "read" });
      const held = hold(chat);
      const page = chat.member.call("GET", searchPath(team.id, "topic"));
      const files = tool(chat, key.token, "knowledge", {
        action: "search",
        projectId: team.id,
        q: "topic",
      });
      const sessions = tool(chat, key.token, "sessions", {
        action: "search",
        projectId: team.id,
        q: "topic",
      });
      for (let i = 0; i < 200 && chat.app.searches.waiting() < 3; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(chat.app.searches.waiting()).toBe(3);
      const removed = await chat.admin.call(
        "DELETE",
        `/api/projects/${team.id}/members/${chat.memberId}`,
      );
      expect(removed.status).toBe(200);
      await held.release();

      // the answers a search asked after the removal gets
      const fresh = await chat.member.call("GET", searchPath(team.id, "topic"));
      const queued = await page;
      expect(queued.status).toBe(fresh.status);
      expect(queued.status).toBe(404);
      expect(await queued.json()).toEqual(await fresh.json());
      const queuedFiles = await files;
      expect(queuedFiles.isError).toBe(true);
      expect(text(queuedFiles)).not.toContain("secret.md");
      expect(queuedFiles).toEqual(
        await tool(chat, key.token, "knowledge", {
          action: "search",
          projectId: team.id,
          q: "topic",
        }),
      );
      expect(await sessions).toEqual(
        await tool(chat, key.token, "sessions", {
          action: "search",
          projectId: team.id,
          q: "topic",
        }),
      );
    } finally {
      await chat.app.shutdown();
    }
  });
});
