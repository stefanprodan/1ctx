// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The inbound MCP endpoint through compose's real wiring: protocol eras,
// access-key boundaries, writes, paging and logs.

import { describe, expect, test } from "bun:test";
import { MAX_KNOWLEDGE_BODY } from "../../src/server/knowledge/index.ts";
import { subscribe } from "../../src/server/lib/bus.ts";
import { silent } from "../../src/server/lib/log.ts";
import { chatMarkdown } from "../../src/server/sessions/index.ts";
import { sanitize } from "../../src/shared/memory.ts";
import { createKey } from "../helpers/access-keys.ts";
import { collectLogs, ORIGIN } from "../helpers/app.ts";
import { type ChatApp, chatApp, setLimits, tick } from "../helpers/chat.ts";
import { createTeam } from "../helpers/projects.ts";

const PAGE_BYTES = 48 * 1024;
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
};

type McpResult = {
  content: (
    | { type: "text"; text: string }
    | {
        type: "resource";
        resource: { text: string };
      }
  )[];
  isError?: boolean;
};

type Mcp = {
  raw(
    body: unknown,
    options?: {
      headers?: Record<string, string>;
      method?: string;
      origin?: string | null;
    },
  ): Promise<Response>;
  rpc(method: string, params?: Record<string, unknown>): Promise<any>;
  tool(name: string, args: unknown): Promise<McpResult>;
};

function mcp(chat: ChatApp, token: string): Mcp {
  const client = chat.app.client();
  let id = 0;
  const raw: Mcp["raw"] = (body, options = {}) =>
    client.call(options.method ?? "POST", "/mcp", {
      ...(body === undefined ? {} : { raw: JSON.stringify(body) }),
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
      origin: options.origin,
    });
  const rpc: Mcp["rpc"] = async (method, params = {}) => {
    const response = await raw(
      {
        jsonrpc: "2.0",
        id: ++id,
        method,
        params: { ...params, _meta: META },
      },
      {
        headers: {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(method === "tools/call"
            ? { "mcp-name": String(params.name) }
            : {}),
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith(
      "application/json",
    );
    return response.json();
  };
  return {
    raw,
    rpc,
    tool: async (name, args) =>
      (await rpc("tools/call", { name, arguments: args })).result,
  };
}

const resultText = (result: McpResult): string =>
  result.content
    .map((part) => (part.type === "text" ? part.text : part.resource.text))
    .join("\n");

const resultBytes = (result: McpResult): number =>
  result.content.reduce(
    (total, part) =>
      total +
      Buffer.byteLength(part.type === "text" ? part.text : part.resource.text),
    0,
  );

function quotedText(result: McpResult): string {
  // the transcript is last; a read-on line, when there is one, comes first
  const text = (result.content.at(-1) as { text: string }).text;
  const marker = text.indexOf("text\n");
  expect(marker).toBeGreaterThan(0);
  const fence = text.slice(text.lastIndexOf("\n", marker - 1) + 1, marker);
  const start = marker + 5;
  const suffix = `\n${fence}`;
  expect(text.endsWith(suffix)).toBe(true);
  return text.slice(start, -suffix.length);
}

async function createFile(
  chat: ChatApp,
  projectId: string,
  name: string,
  text: string,
) {
  const response = await chat.member.call(
    "POST",
    `/api/projects/${projectId}/knowledge`,
    { body: { name, text } },
  );
  expect(response.status).toBe(201);
  return (await response.json()).file as {
    id: string;
    name: string;
    revision: number;
  };
}

async function settle(chat: ChatApp, sessionId: string) {
  for (let index = 0; index < 400; index++) {
    if (chat.app.sessions.byId(sessionId)?.status !== "running") return;
    await tick();
  }
  throw new Error("session did not settle");
}

describe("the composed inbound MCP endpoint", () => {
  test("serves both protocol eras, key scopes, origins and message limits", async () => {
    const chat = await chatApp();
    try {
      const readKey = await createKey(chat.member, {
        name: "reader",
        scope: "read",
      });
      const writeKey = await createKey(chat.member, {
        name: "writer",
        scope: "write",
      });
      const read = mcp(chat, readKey.token);
      const legacyHeaders = { accept: "application/json, text/event-stream" };
      const initialized = await read.raw(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "legacy-client", version: "1" },
          },
        },
        { headers: legacyHeaders },
      );
      expect(initialized.status).toBe(200);
      expect(initialized.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      expect(await initialized.text()).toContain(
        '"protocolVersion":"2025-11-25"',
      );
      const notice = await read.raw(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          headers: {
            ...legacyHeaders,
            "mcp-protocol-version": "2025-11-25",
          },
        },
      );
      expect(notice.status).toBe(202);
      const ping = await read.raw(
        { jsonrpc: "2.0", id: 2, method: "ping" },
        {
          headers: {
            ...legacyHeaders,
            "mcp-protocol-version": "2025-11-25",
          },
        },
      );
      expect(await ping.text()).toContain('"result":{}');

      const discovered = await read.rpc("server/discover");
      expect(discovered.result.supportedVersions).toEqual(["2026-07-28"]);
      expect(discovered.result.capabilities.tools.listChanged).toBe(false);
      const readTools = await read.rpc("tools/list");
      const readKnowledge = readTools.result.tools.find(
        (tool: { name: string }) => tool.name === "knowledge",
      );
      expect(readKnowledge.inputSchema.properties.action.enum).toEqual([
        "list",
        "search",
        "read",
        "versions",
        "version",
      ]);
      expect(readKnowledge.description).not.toMatch(
        /write|scope|create|edit|replace|rename|delete/i,
      );
      expect(readKnowledge.inputSchema.properties).not.toHaveProperty("name");
      expect(readKnowledge.inputSchema.properties).not.toHaveProperty("text");
      expect(readKnowledge.inputSchema.properties).not.toHaveProperty("edits");
      const forged = await read.tool("knowledge", {
        action: "rename",
        projectId: chat.projectId,
        fileId: "missing00001",
        name: "other.md",
      });
      expect(forged.isError).toBe(true);
      expect(resultText(forged)).toBe("this access key is read-only");

      const writeTools = await mcp(chat, writeKey.token).rpc("tools/list");
      const writeKnowledge = writeTools.result.tools.find(
        (tool: { name: string }) => tool.name === "knowledge",
      );
      expect(writeKnowledge.inputSchema.properties.action.enum).toContain(
        "delete",
      );
      expect(writeKnowledge.description).toContain(
        "every old must match exactly once",
      );
      expect(writeKnowledge.description).toContain(
        "whole text after reading the file in full",
      );

      const foreign = await read.raw(
        { jsonrpc: "2.0", id: 3, method: "ping" },
        { headers: legacyHeaders, origin: "http://foreign.test" },
      );
      expect(foreign.status).toBe(403);
      const missing = await read.raw(
        { jsonrpc: "2.0", id: 4, method: "ping" },
        { headers: legacyHeaders, origin: null },
      );
      expect(missing.status).toBe(200);

      const batchKey = await createKey(chat.member, {
        name: "batch",
        scope: "read",
      });
      const batchClient = mcp(chat, batchKey.token);
      const batch = Array.from({ length: 3 }, (_, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "ping",
      }));
      for (let index = 0; index < 40; index++) {
        const response = await batchClient.raw(batch, {
          headers: legacyHeaders,
        });
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body.match(/"result":\{\}/g)).toHaveLength(3);
      }
      expect(
        (
          await batchClient.raw(
            { jsonrpc: "2.0", id: 121, method: "ping" },
            { headers: legacyHeaders },
          )
        ).status,
      ).toBe(429);
      const malformed = await chat.app.client().call("POST", "/mcp", {
        raw: " ".repeat(1024 * 1024),
        headers: { authorization: `Bearer ${batchKey.token}` },
        origin: null,
      });
      expect(malformed.status).toBe(429);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("answers 413 before the SDK and disables every key method at zero", async () => {
    const chat = await chatApp();
    try {
      const key = await createKey(chat.member, {
        name: "body",
        scope: "write",
      });
      const client = mcp(chat, key.token);
      await setLimits(chat, {
        knowledgeFileBytes: 4 * 1024 * 1024,
        knowledgeProjectBytes: 64 * 1024 * 1024,
      });
      const fitting = await client.tool("knowledge", {
        action: "create",
        projectId: chat.projectId,
        name: "lines.md",
        text: "\n".repeat(4 * 1024 * 1024),
      });
      expect(fitting.isError).toBeUndefined();
      const escaped = await client.raw({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "knowledge",
          arguments: {
            action: "create",
            projectId: chat.projectId,
            name: "control.md",
            text: "\u0001".repeat(4 * 1024 * 1024),
          },
          _meta: META,
        },
      });
      expect(escaped.status).toBe(413);
      const raw = await chat.app.client().call("POST", "/mcp", {
        raw: " ".repeat(MAX_KNOWLEDGE_BODY + 1),
        headers: { authorization: `Bearer ${key.token}` },
      });
      expect(raw.status).toBe(413);

      await setLimits(chat, { accessKeysPerUser: 0 });
      for (const method of ["POST", "GET", "DELETE"]) {
        const response = await client.raw(
          method === "POST"
            ? { jsonrpc: "2.0", id: 2, method: "ping" }
            : undefined,
          { method },
        );
        expect(response.status).toBe(404);
      }
    } finally {
      await chat.app.shutdown();
    }
  });

  test.serial(
    "writes preserve key history, events and stale revisions",
    async () => {
      const chat = await chatApp();
      const events: any[] = [];
      const unsubscribe = subscribe((event) => {
        if (event.type === "knowledge.changed") events.push(event);
      }, silent);
      try {
        const key = await createKey(chat.member, {
          name: "workstation",
          scope: "write",
        });
        const client = mcp(chat, key.token);
        const created = await client.tool("knowledge", {
          action: "create",
          projectId: chat.projectId,
          name: "plan.md",
          text: "one\ntwo\nthree\n",
        });
        const file = JSON.parse(resultText(created));
        const edited = await client.tool("knowledge", {
          action: "edit",
          projectId: chat.projectId,
          fileId: file.id,
          revision: file.revision,
          edits: [{ old: "two", new: "TWO" }],
        });
        const afterEdit = JSON.parse(resultText(edited));
        const staleReplace = await client.tool("knowledge", {
          action: "replace",
          projectId: chat.projectId,
          fileId: file.id,
          revision: file.revision,
          text: "stale",
        });
        expect(staleReplace.isError).toBe(true);
        expect(resultText(staleReplace)).toContain("revision");
        const replaced = await client.tool("knowledge", {
          action: "replace",
          projectId: chat.projectId,
          fileId: file.id,
          revision: afterEdit.revision,
          text: "fresh\n",
        });
        const afterReplace = JSON.parse(resultText(replaced));
        const renamed = await client.tool("knowledge", {
          action: "rename",
          projectId: chat.projectId,
          fileId: file.id,
          revision: afterReplace.revision,
          name: "docs/plan.md",
        });
        const afterRename = JSON.parse(resultText(renamed));
        const staleDelete = await client.tool("knowledge", {
          action: "delete",
          projectId: chat.projectId,
          fileId: file.id,
          revision: afterReplace.revision,
        });
        expect(staleDelete.isError).toBe(true);
        const deleted = await client.tool("knowledge", {
          action: "delete",
          projectId: chat.projectId,
          fileId: file.id,
          revision: afterRename.revision,
        });
        expect(deleted.isError).toBeUndefined();

        const history = await chat.member.call(
          "GET",
          `/api/projects/${chat.projectId}/knowledge/files/${file.id}/versions`,
        );
        expect(history.status).toBe(200);
        const { versions } = await history.json();
        expect(versions).toHaveLength(5);
        for (const version of versions) {
          expect(version.author.origin).toBe("key");
          expect(version.author.keyName).toBe("workstation");
        }
        expect(events).toHaveLength(5);
        for (const event of events) {
          expect(event.data.file.author.origin).toBe("key");
          expect(event.data.file.author.keyName).toBe("workstation");
        }
      } finally {
        unsubscribe();
        await chat.app.shutdown();
      }
    },
  );

  test("refuses a write when its key is revoked while the body is read", async () => {
    const chat = await chatApp();
    try {
      const key = await createKey(chat.member, {
        name: "short-lived",
        scope: "write",
      });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "knowledge",
          arguments: {
            action: "create",
            projectId: chat.projectId,
            name: "late.md",
            text: "late",
          },
          _meta: META,
        },
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const half = Math.floor(payload.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(payload.slice(0, half)));
          await gate;
          controller.enqueue(new TextEncoder().encode(payload.slice(half)));
          controller.close();
        },
      });
      const request = new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          host: "1ctx.test",
          authorization: `Bearer ${key.token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "knowledge",
        },
        body: stream,
      });
      const pending = chat.app.handle(request, "127.0.0.1");
      await tick();
      expect(
        (await chat.member.call("DELETE", `/api/profile/keys/${key.key.id}`))
          .status,
      ).toBe(204);
      release();
      const response = (await pending)!;
      expect(response.status).toBe(200);
      const answer = await response.json();
      expect(answer.result.isError).toBe(true);
      const files = await chat.member.call(
        "GET",
        `/api/projects/${chat.projectId}/knowledge`,
      );
      expect(JSON.stringify(await files.json())).not.toContain("late.md");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("narrows files and sessions like missing objects on every call", async () => {
    const chat = await chatApp();
    try {
      const team = await createTeam(chat.admin, "alpha", [chat.memberId]);
      const other = await createTeam(chat.admin, "beta", [chat.memberId]);
      const own = await createFile(chat, chat.projectId, "own.md", "own");
      const hiddenFile = await createFile(
        chat,
        other.id,
        "hidden.md",
        "hidden",
      );
      const key = await createKey(chat.member, {
        name: "narrow",
        scope: "write",
        projectIds: [team.id],
      });
      const client = mcp(chat, key.token);
      const projects = resultText(
        await client.tool("projects", { action: "list" }),
      );
      expect(projects).toContain(team.id);
      expect(projects).not.toContain(other.id);
      expect(projects).not.toContain(chat.projectId);

      const hiddenProject = await client.tool("knowledge", {
        action: "read",
        projectId: other.id,
        fileId: hiddenFile.id,
      });
      const missingProject = await client.tool("knowledge", {
        action: "read",
        projectId: "missing00001",
        fileId: hiddenFile.id,
      });
      expect(hiddenProject).toEqual(missingProject);
      const crossedFile = await client.tool("knowledge", {
        action: "read",
        projectId: team.id,
        fileId: own.id,
      });
      const missingFile = await client.tool("knowledge", {
        action: "read",
        projectId: team.id,
        fileId: "missing00002",
      });
      expect(crossedFile).toEqual(missingFile);

      const pending = chat.scripted.next();
      const started = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "hello",
        },
      });
      const sessionId = (await started.json()).session.id;
      (await pending).reply("private answer");
      await settle(chat, sessionId);
      const hiddenSession = await client.tool("sessions", {
        action: "read",
        sessionId,
      });
      const missingSession = await client.tool("sessions", {
        action: "read",
        sessionId: "missing00003",
      });
      expect(hiddenSession).toEqual(missingSession);

      expect(
        (
          await chat.admin.call(
            "DELETE",
            `/api/projects/${team.id}/members/${chat.memberId}`,
          )
        ).status,
      ).toBe(200);
      expect(
        resultText(await client.tool("projects", { action: "list" })),
      ).toBe("");
      expect(
        (
          await client.tool("knowledge", {
            action: "list",
            projectId: team.id,
          })
        ).isError,
      ).toBe(true);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("takes knowledge edit pairs exactly as sent", async () => {
    const chat = await chatApp();
    try {
      const key = await createKey(chat.member, {
        name: "exact-edits",
        scope: "write",
      });
      const client = mcp(chat, key.token);
      const oldCase = await createFile(
        chat,
        chat.projectId,
        "old-marker.md",
        "prefix foo suffix",
      );
      const absent = await client.tool("knowledge", {
        action: "edit",
        projectId: chat.projectId,
        fileId: oldCase.id,
        revision: oldCase.revision,
        edits: [{ old: "\ufefffoo", new: "bar" }],
      });
      expect(absent.isError).toBe(true);
      expect(
        chat.app.knowledge.store.byId(chat.projectId, oldCase.id)?.text,
      ).toBe("prefix foo suffix");

      const newCase = await createFile(
        chat,
        chat.projectId,
        "new-marker.md",
        "prefix foo suffix",
      );
      const preserved = await client.tool("knowledge", {
        action: "edit",
        projectId: chat.projectId,
        fileId: newCase.id,
        revision: newCase.revision,
        edits: [{ old: "foo", new: "\ufeffbar" }],
      });
      expect(preserved.isError).toBeUndefined();
      expect(
        chat.app.knowledge.store.byId(chat.projectId, newCase.id)?.text,
      ).toBe("prefix \ufeffbar suffix");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("refuses a knowledge list continuation after a rename", async () => {
    const chat = await chatApp();
    try {
      const key = await createKey(chat.member, {
        name: "list-reader",
        scope: "write",
      });
      const client = mcp(chat, key.token);
      const author = {
        kind: "user" as const,
        id: chat.memberId,
        name: "casey",
        sessionId: null,
        origin: null,
        keyName: null,
      };
      for (let index = 0; index < 250; index++) {
        chat.app.knowledge.create(
          chat.projectId,
          author,
          `${String(index).padStart(4, "0")}-${"x".repeat(70)}/${"y".repeat(70)}/plan.md`,
          "x",
        );
      }
      const first = await client.tool("knowledge", {
        action: "list",
        projectId: chat.projectId,
      });
      const continuation = resultText(first).match(
        /after=("[^"]+"), stamp=([0-9a-f]{64})\./,
      )!;
      const after = JSON.parse(continuation[1]!);
      const stamp = continuation[2]!;
      const unread = chat.app.knowledge
        .list(chat.projectId)
        .files.find((file) => file.name > after)!;
      chat.app.knowledge.rename(
        chat.projectId,
        author,
        unread.id,
        "0000-renamed.md",
        unread.revision,
      );
      const changed = await client.tool("knowledge", {
        action: "list",
        projectId: chat.projectId,
        after,
        stamp,
      });
      expect(changed.isError).toBe(true);
      expect(resultText(changed)).toContain(
        "the file list changed; read from the start",
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("answers a knowledge file whole and refuses one of 1 MiB", async () => {
    const chat = await chatApp();
    try {
      await setLimits(chat, {
        knowledgeFileBytes: 4 * 1024 * 1024,
        knowledgeProjectBytes: 16 * 1024 * 1024,
      });
      const key = await createKey(chat.member, {
        name: "whole",
        scope: "write",
      });
      const client = mcp(chat, key.token);
      const text = `start\n${"😀".repeat(50_000)}\nend\n`;
      const file = await createFile(chat, chat.projectId, "large.md", text);
      const read = await client.tool("knowledge", {
        action: "read",
        projectId: chat.projectId,
        fileId: file.id,
      });
      expect(read.isError).toBeFalsy();
      expect(resultBytes(read)).toBeGreaterThan(PAGE_BYTES);
      expect((read.content[0] as { text: string }).text).toContain(
        `Revision ${file.revision}.`,
      );
      const resource = read.content.find(
        (part) => part.type === "resource",
      ) as { type: "resource"; resource: { text: string; uri: string } };
      expect(resource.resource.text).toBe(text);
      expect(resource.resource.uri).toContain(`revision=${file.revision}`);

      const versions = await client.tool("knowledge", {
        action: "versions",
        projectId: chat.projectId,
        fileId: file.id,
      });
      const old = JSON.parse(resultText(versions).split("\n")[0]!);
      const version = await client.tool("knowledge", {
        action: "version",
        projectId: chat.projectId,
        versionId: old.id,
      });
      expect(
        (
          version.content.find((part) => part.type === "resource") as {
            resource: { text: string };
          }
        ).resource.text,
      ).toBe(text);

      const exact = " lead\r\nbell \u0007 and \u202e turn\t\n\n";
      const odd = await createFile(chat, chat.projectId, "odd.md", exact);
      const oddRead = await client.tool("knowledge", {
        action: "read",
        projectId: chat.projectId,
        fileId: odd.id,
      });
      expect(
        (
          oddRead.content.find((part) => part.type === "resource") as {
            resource: { text: string };
          }
        ).resource.text,
      ).toBe(exact);

      const under = await createFile(
        chat,
        chat.projectId,
        "under.md",
        "a".repeat(1024 * 1024 - 1),
      );
      const underRead = await client.tool("knowledge", {
        action: "read",
        projectId: chat.projectId,
        fileId: under.id,
      });
      expect(underRead.isError).toBeFalsy();

      // the limit counts bytes: 600,000 two-byte characters are over it
      const huge = await createFile(
        chat,
        chat.projectId,
        "huge.md",
        "é".repeat(600_000),
      );
      const refused = await client.tool("knowledge", {
        action: "read",
        projectId: chat.projectId,
        fileId: huge.id,
      });
      expect(refused.isError).toBe(true);
      expect(resultText(refused)).toContain("read it on the page");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("pages inside a session message and detects regeneration", async () => {
    const chat = await chatApp();
    try {
      const key = await createKey(chat.member, {
        name: "session-reader",
        scope: "read",
      });
      const client = mcp(chat, key.token);
      const pending = chat.scripted.next();
      const started = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "read this",
        },
      });
      const sessionId = (await started.json()).session.id;
      (await pending).reply("é".repeat(40_000) + "😀".repeat(20_000));
      await settle(chat, sessionId);

      const pages: McpResult[] = [];
      let args: Record<string, unknown> = { action: "read", sessionId };
      for (let page = 0; page < 20; page++) {
        const result = await client.tool("sessions", args);
        pages.push(result);
        expect(resultBytes(result)).toBeLessThanOrEqual(PAGE_BYTES);
        const next = (result.content[0] as { text?: string }).text?.match(
          /messageId=(\w+), offset=(\d+)/,
        );
        if (!next) break;
        args = {
          action: "read",
          sessionId,
          messageId: next[1],
          offset: Number(next[2]),
        };
      }
      expect(pages.length).toBeGreaterThan(2);
      const exportedResponse = await chat.member.call(
        "GET",
        `/api/sessions/${sessionId}/markdown?tz=UTC`,
      );
      const exported = await exportedResponse.text();
      expect(exported).toBe(
        chatMarkdown(
          chat.app.sessions.byId(sessionId)!.title,
          chat.app.sessions.exportRows(sessionId),
          "UTC",
        ),
      );
      expect(pages.map(quotedText).join("")).toBe(`${sanitize(exported)}\n`);

      const cursor = (pages[0]!.content[0] as { text: string }).text.match(
        /messageId=(\w+), offset=(\d+)/,
      )!;
      const regenerated = chat.scripted.next();
      expect(
        (
          await chat.member.call(
            "POST",
            `/api/sessions/${sessionId}/regenerate`,
          )
        ).status,
      ).toBe(201);
      (await regenerated).reply(`replacement ${"x".repeat(80_000)}`);
      await settle(chat, sessionId);
      const changed = await client.tool("sessions", {
        action: "read",
        sessionId,
        messageId: cursor[1],
        offset: Number(cursor[2]),
      });
      expect(changed.isError).toBe(true);
      expect(resultText(changed)).toContain("read from the start");
      const after = await client.tool("sessions", {
        action: "read",
        sessionId,
      });
      expect(resultBytes(after)).toBeLessThanOrEqual(PAGE_BYTES);
      expect(after.content.at(-1)).toHaveProperty("text");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("logs one safe event for each tool call", async () => {
    const logs = collectLogs();
    const chat = await chatApp({ logFactory: logs.logFactory });
    try {
      const key = await createKey(chat.member, {
        name: "key-name-marker",
        scope: "write",
      });
      const client = mcp(chat, key.token);
      const before = logs.events.length;
      await client.tool("knowledge", {
        action: "create",
        projectId: chat.projectId,
        name: "argument-name-marker.md",
        text: "argument-text-marker",
      });
      await client.tool("knowledge", {
        action: "read",
        projectId: chat.projectId,
        fileId: "missing00004",
      });
      const mismatch = await client.raw(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: key.token,
            arguments: { action: "list", projectId: chat.projectId },
            _meta: META,
          },
        },
        {
          headers: {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "knowledge",
          },
        },
      );
      expect(mismatch.status).toBe(400);
      const events = logs.events.slice(before);
      expect(events.filter((event) => event.msg === "mcp call")).toHaveLength(
        2,
      );
      expect(events.filter((event) => event.msg === "mcp error")).toHaveLength(
        1,
      );
      expect(
        events.find((event) => event.msg === "mcp error")?.fields,
      ).toMatchObject({ error: "mcp sdk error" });
      expect(events.filter((event) => event.msg === "request")).toHaveLength(1);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("key-name-marker");
      expect(serialized).not.toContain("argument-name-marker");
      expect(serialized).not.toContain("argument-text-marker");
      expect(serialized).not.toContain(key.token);
    } finally {
      await chat.app.shutdown();
    }
  });
});
