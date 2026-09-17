// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Tool and limit administration through the composed server. Assertions
// inspect the runner's immutable policy while a provider stream is open,
// then start another send to prove when a setting takes effect.

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../src/server/limits/index.ts";
import type { Offered } from "../../src/server/tools/index.ts";
import { type ChatApp, chatApp, startChat, tick } from "../helpers/chat.ts";

const names = (offered: Offered) => offered.tools.map((tool) => tool.name);

function codeJson(html: string): unknown {
  const code = html.match(
    /<code class="md-block-code">([\s\S]*?)<\/code>/,
  )?.[1];
  if (code === undefined) throw new Error("rendered code block is missing");
  const json = code
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
  return JSON.parse(json);
}

async function finish(chat: ChatApp, script: { reply(text: string): void }) {
  script.reply("done");
  for (let i = 0; i < 100 && chat.app.runner.registry.size > 0; i++) {
    await tick();
  }
  expect(chat.app.runner.registry.size).toBe(0);
}

describe("tools administration", () => {
  test("the response carries the schema as highlighted JSON", async () => {
    const chat = await chatApp();
    const res = await chat.admin.call("GET", "/api/tools");
    expect(res.status).toBe(200);
    const body = await res.json();
    const tool = body.web.find(
      (candidate: { name: string }) => candidate.name === "webfetch",
    );
    expect(tool).toBeDefined();
    expect(tool.parametersHtml).toContain(
      '<div class="md-block" data-lang="json">',
    );
    expect(tool.parametersHtml).toContain(
      '<span class="md-block-lang">json</span>',
    );
    expect(tool.parametersHtml).toContain('class="md-copy"');
    expect(tool.parametersHtml).toContain('class="md-block-code"');
    expect(tool.parametersHtml).toContain('class="hljs-attr"');
    expect(codeJson(tool.parametersHtml)).toEqual(tool.parameters);
    expect(tool.tokens).toBeGreaterThan(0);
    expect(body.builtin.map((t: { name: string }) => t.name)).toEqual([
      "datetime",
      "mcp_call",
      "mcp_describe",
      "memory_edit",
      "session_read",
      "sessions_list",
      "skill",
      "skill_file",
    ]);
    expect(codeJson(body.builtin[0].parametersHtml)).toEqual(
      body.builtin[0].parameters,
    );
    chat.app.socket.dispose();
  });

  test("a switch changes the next send and PATCH answers the full safe body", async () => {
    const chat = await chatApp({
      secrets: { "search-exa": "never-return-this-key" },
    });
    const first = await startChat(chat, "first");
    const active = chat.app.runner.registry.get(first.sessionId)!;
    expect(names(active.policy.offered)).toContain("webfetch");

    const changed = await chat.admin.call("PATCH", "/api/tools/webfetch", {
      body: { enabled: false },
    });
    expect(changed.status).toBe(200);
    const text = await changed.text();
    expect(text).not.toContain("never-return-this-key");
    const body = JSON.parse(text);
    expect(body.web).toHaveLength(3);
    expect(body.builtin).toHaveLength(8);
    expect(body.search).toEqual({
      provider: null,
      keys: { exa: true, firecrawl: false, tavily: false },
    });
    expect(
      body.web.find((tool: { name: string }) => tool.name === "webfetch"),
    ).toMatchObject({
      enabled: false,
      description: expect.any(String),
      parameters: expect.any(Object),
      updatedAt: chat.app.now.value,
    });

    expect(names(active.policy.offered)).toContain("webfetch");
    await finish(chat, first.script);
    const second = await startChat(chat, "second");
    expect(
      names(chat.app.runner.registry.get(second.sessionId)!.policy.offered),
    ).not.toContain("webfetch");
    await finish(chat, second.script);
    chat.app.socket.dispose();
  });

  test("websearch is offered once chosen, with or without its key", async () => {
    const chat = await chatApp({ secrets: { "search-exa": "exa-key" } });
    const selected = await chat.admin.call("PATCH", "/api/tools/websearch", {
      body: { provider: "exa" },
    });
    expect(selected.status).toBe(200);

    const keyed = await startChat(chat, "with key");
    expect(
      names(chat.app.runner.registry.get(keyed.sessionId)!.policy.offered),
    ).toContain("websearch");
    await finish(chat, keyed.script);

    delete chat.secrets.exa;
    const missing = await startChat(chat, "without key");
    expect(
      names(chat.app.runner.registry.get(missing.sessionId)!.policy.offered),
    ).toContain("websearch");
    await finish(chat, missing.script);
    const cleared = await chat.admin.call("PATCH", "/api/tools/websearch", {
      body: { provider: null },
    });
    expect(cleared.status).toBe(200);
    const unchosen = await startChat(chat, "no provider");
    expect(
      names(chat.app.runner.registry.get(unchosen.sessionId)!.policy.offered),
    ).not.toContain("websearch");
    await finish(chat, unchosen.script);
    chat.app.socket.dispose();
  });

  test("a built-in has no switch to patch", async () => {
    const chat = await chatApp();
    const res = await chat.admin.call("PATCH", "/api/tools/datetime", {
      body: { enabled: false },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no such tool" });
    chat.app.socket.dispose();
  });

  test("a provider on a non-search tool is refused", async () => {
    const chat = await chatApp();
    const res = await chat.admin.call("PATCH", "/api/tools/webfetch", {
      body: { provider: "exa" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "provider is only valid on websearch",
    });
    chat.app.socket.dispose();
  });

  test("limit changes are snapshotted by the next send", async () => {
    const chat = await chatApp();
    const first = await startChat(chat, "old limits");
    const active = chat.app.runner.registry.get(first.sessionId)!;
    expect(active.policy.limits.rounds).toBe(DEFAULT_LIMITS.rounds);

    const changed = await chat.admin.call("PUT", "/api/limits", {
      body: { values: { ...DEFAULT_LIMITS, rounds: 2 } },
    });
    expect(changed.status).toBe(200);
    expect(active.policy.limits.rounds).toBe(DEFAULT_LIMITS.rounds);
    await finish(chat, first.script);

    const second = await startChat(chat, "new limits");
    expect(
      chat.app.runner.registry.get(second.sessionId)!.policy.limits.rounds,
    ).toBe(2);
    await finish(chat, second.script);
    chat.app.socket.dispose();
  });

  test("the compaction limits round-trip through the admin routes", async () => {
    const chat = await chatApp();
    const initial = await (await chat.admin.call("GET", "/api/limits")).json();
    expect(
      initial.limits
        .filter((row: { name: string }) =>
          ["contextReserve", "summaryMaxTokens"].includes(row.name),
        )
        .map((row: { name: string; value: number; unit: string }) => ({
          name: row.name,
          value: row.value,
          unit: row.unit,
        })),
    ).toEqual([
      { name: "contextReserve", value: 20_000, unit: "tokens" },
      { name: "summaryMaxTokens", value: 4096, unit: "tokens" },
    ]);
    const updated = await chat.admin.call("PUT", "/api/limits", {
      body: {
        values: {
          ...DEFAULT_LIMITS,
          contextReserve: 30_000,
          summaryMaxTokens: 8192,
        },
      },
    });
    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(
      body.limits
        .filter((row: { name: string }) =>
          ["contextReserve", "summaryMaxTokens"].includes(row.name),
        )
        .map((row: { name: string; value: number }) => ({
          name: row.name,
          value: row.value,
        })),
    ).toEqual([
      { name: "contextReserve", value: 30_000 },
      { name: "summaryMaxTokens", value: 8192 },
    ]);
    chat.app.socket.dispose();
  });

  test("the migrations leave exactly the three web tool rows", async () => {
    const chat = await chatApp();
    expect(
      chat.app.db
        .query<{ name: string }, []>("select name from tools order by rowid")
        .all()
        .map((row) => row.name),
    ).toEqual(["webfetch", "websearch", "visualize"]);
    chat.app.socket.dispose();
  });
});
