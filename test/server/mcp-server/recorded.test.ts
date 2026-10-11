// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Recorded client traffic replayed in order through compose's handler.

import { describe, expect, test } from "bun:test";
import { createKey } from "../../helpers/access-keys.ts";
import { type ChatApp, chatApp } from "../../helpers/chat.ts";

const RECORDED_PROJECT = "3v3y45ybv0qp";
const RECORDED_FILE = "u1by703f19rr";

type Recording = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  status: number;
  contentType: string | null;
};

const recordings = [
  {
    name: "Claude Code 2.1.296",
    fixture: "claude-code-2.1.296.jsonl",
    scope: "read" as const,
  },
  {
    name: "OpenCode 2.0.26",
    fixture: "opencode-2.0.26.jsonl",
    scope: "write" as const,
  },
];

async function load(name: string): Promise<Recording[]> {
  const text = await Bun.file(
    new URL(`../../fixtures/mcp-server/${name}`, import.meta.url),
  ).text();
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Recording);
}

async function prepare(scope: "read" | "write") {
  const chat = await chatApp();
  const created = await chat.member.call(
    "POST",
    `/api/projects/${chat.projectId}/knowledge`,
    { body: { name: "plans/demo.md", text: "line one\nline two\n" } },
  );
  expect(created.status).toBe(201);
  const first = (await created.json()).file;
  const updated = await chat.member.call(
    "PUT",
    `/api/projects/${chat.projectId}/knowledge/files/${first.id}`,
    {
      body: {
        revision: first.revision,
        text: "# Demo\n\nline one\nline two, edited by claude code\n",
      },
    },
  );
  expect(updated.status).toBe(200);
  const file = (await updated.json()).file;
  expect(file.revision).toBe(2);
  const key = await createKey(chat.member, {
    name: `${scope}-recording`,
    scope,
  });
  return { chat, file, token: key.token };
}

function rewrite(body: string, chat: ChatApp, fileId: string): string {
  return body
    .replaceAll(RECORDED_PROJECT, chat.projectId)
    .replaceAll(RECORDED_FILE, fileId);
}

function message(text: string, contentType: string | null): any {
  if (contentType?.startsWith("text/event-stream")) {
    const data = text
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    return data === undefined ? null : JSON.parse(data);
  }
  return text === "" ? null : JSON.parse(text);
}

function expectedToolError(body: any): boolean {
  const args = body.params?.arguments;
  return args?.action === "rename" || (args?.action === "read" && args.name);
}

describe("recorded MCP clients", () => {
  for (const recorded of recordings) {
    test(`${recorded.name} requests pass the handler`, async () => {
      const fixture = await load(recorded.fixture);
      const { chat, file, token } = await prepare(recorded.scope);
      const client = chat.app.client();
      try {
        for (const entry of fixture) {
          const body =
            entry.body === null
              ? null
              : JSON.parse(rewrite(entry.body, chat, file.id));
          const response = await client.call(entry.method, entry.path, {
            ...(body === null ? {} : { raw: JSON.stringify(body) }),
            headers: {
              ...entry.headers,
              authorization: `Bearer ${token}`,
            },
            origin: null,
          });
          expect(response.status).toBe(entry.status);
          expect(response.headers.get("content-type")).toBe(entry.contentType);
          const text = await response.text();
          if (body?.method !== "tools/call") continue;
          const answer = message(text, entry.contentType);
          expect(answer.error).toBeUndefined();
          if (expectedToolError(body)) {
            expect(answer.result.isError).toBe(true);
          } else {
            expect(answer.result.isError).toBeUndefined();
          }
        }
      } finally {
        await chat.app.shutdown();
      }
    });
  }
});
