// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import { makeBashTool } from "../../../src/server/tools/builtin/bash.ts";
import { toolsArea } from "../../../src/server/tools/index.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import type { WebAccessMode } from "../../../src/shared/web.ts";
import { testApp } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";

function setup() {
  const db = memoryDb();
  const fetched: string[] = [];
  const tools = toolsArea({
    db,
    clock: () => 1,
    log: silent,
    version: "test",
    render: (text) => text,
    secret: () => null,
    skills: {
      forAgent: () => [],
      body: () => null,
      file: () => null,
    },
    fetcher: (async (input) => {
      fetched.push(String(input));
      return new Response("page", {
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch,
  });
  return { db, tools, fetched };
}

const context = (): ToolContext => ({
  web: null,
  actor: null,
  now: () => 0,
  signal: new AbortController().signal,
  budget: { bashCalls: 0, fetches: 0, searches: 0, visualBytes: 0, visuals: 0 },
  caps: TOOL_CAPS,
});

for (const mode of ["off", "all", "listed"] as const) {
  for (const disabled of [false, true]) {
    for (const provider of [null, "exa"] as const) {
      test(`${mode}, disabled=${disabled}, provider=${provider}`, async () => {
        const { db, tools, fetched } = setup();
        try {
          tools.store.setAccess(mode, ["docs.test"], 1);
          tools.store.setProvider(provider, 1);
          expect(tools.webAccess()).toEqual({
            mode,
            domains: ["docs.test"],
            updatedAt: 1,
          });
          const offered = tools.offered(
            1,
            "",
            [],
            "auto",
            undefined,
            disabled ? ["web"] : [],
          );
          const on = mode !== "off" && !disabled;
          const names = offered.tools.map((tool) => tool.name);
          expect(names.includes("webfetch")).toBe(on);
          expect(names.includes("websearch")).toBe(on && provider !== null);
          expect(names).toContain("visualize");
          expect(offered.web).toEqual(
            on ? { mode, domains: ["docs.test"] } : null,
          );
          expect(tools.capabilities()).toEqual(
            mode === "off" ? ["visualize"] : ["web", "visualize"],
          );
          const bash = offered.tools.find((tool) => tool.name === "bash")!;
          expect(bash.description.endsWith("No network.")).toBe(!on);
          if (on) expect(bash.description).toContain("curl");
          if (!on) {
            for (const name of ["webfetch", "websearch"]) {
              expect(
                await tools.run(
                  offered,
                  {
                    id: name,
                    name,
                    arguments: "{}",
                  },
                  context(),
                ),
              ).toEqual({
                error: true,
                content: `Error: tool "${name}" not found.`,
              });
            }
            expect(fetched).toEqual([]);
          }
        } finally {
          db.close();
        }
      });
    }
  }
}

test("the send keeps domains, search and schema after the rows change", async () => {
  const { db, tools, fetched } = setup();
  try {
    const domains = ["docs.test"];
    tools.store.setAccess("listed", domains, 1);
    tools.store.setProvider("tavily", 1);
    const offered = tools.offered(1, "");
    const before = JSON.stringify(offered);
    domains.push("other.test");
    tools.store.setAccess("off", ["other.test"], 2);
    tools.store.setProvider(null, 2);
    expect(JSON.stringify(offered)).toBe(before);
    expect(tools.offered(2, "").web).toBeNull();
    expect(
      await tools.run(
        offered,
        {
          id: "old",
          name: "webfetch",
          arguments: '{"url":"https://docs.test/a"}',
        },
        context(),
      ),
    ).toMatchObject({ error: false, content: "page" });
    expect(
      await tools.run(
        offered,
        {
          id: "other",
          name: "webfetch",
          arguments: '{"url":"https://other.test/a"}',
        },
        context(),
      ),
    ).toMatchObject({
      error: true,
      content: "Error: not an allowed domain: other.test",
    });
    expect(fetched).toEqual(["https://docs.test/a"]);
  } finally {
    db.close();
  }
});

test("the obsolete web switches do not change the offered names", () => {
  const { db, tools } = setup();
  try {
    tools.store.setProvider("exa", 1);
    tools.store.setEnabled("webfetch", false, 1);
    tools.store.setEnabled("websearch", false, 1);
    expect(tools.offered(1, "").tools.map((tool) => tool.name)).toContain(
      "webfetch",
    );
    expect(tools.offered(1, "").tools.map((tool) => tool.name)).toContain(
      "websearch",
    );
  } finally {
    db.close();
  }
});

test("bash names at most ten hosts and forwards the send's network caps", async () => {
  const domains = Array.from({ length: 12 }, (_, index) => `host${index}.test`);
  const web = { mode: "listed" as const, domains };
  const ctx = context();
  ctx.web = web;
  ctx.actor = {
    projectId: "p",
    sessionId: "s",
    userId: "u",
    agentId: "a",
    agentName: "agent",
    origin: "chat",
  };
  const tool = makeBashTool(
    {
      async run(_project, _session, _author, _command, caps, signal) {
        expect(caps).toEqual({
          callTimeoutMs: TOOL_CAPS.callTimeoutMs,
          resultCut: TOOL_CAPS.resultCut,
          visuals: true,
          fetchDeadlineMs: TOOL_CAPS.fetchDeadlineMs,
          fetchBodyBytes: TOOL_CAPS.fetchBodyBytes,
          web,
        });
        expect(signal).toBe(ctx.signal);
        return { content: "exit 0", error: false };
      },
    },
    web,
  );
  expect(tool.description).toContain("host9.test and 2 more");
  expect(tool.description).not.toContain("host10.test");
  expect(tool.description).toContain("Save downloads in /tmp");
  expect(tool.description).not.toContain(";");
  expect(tool.description).not.toContain("\n");
  expect(await tool.run({ command: "true" }, ctx)).toEqual({
    content: "exit 0",
    error: false,
  });
});

test("tools routes expose access, None and the independent visual settings", async () => {
  const app = await testApp({ adminPassword: "initial-password" });
  const client = app.client();
  try {
    expect((await client.login("admin", "initial-password")).status).toBe(200);
    const first = (await (
      await client.call("GET", "/api/tools")
    ).json()) as ToolsResponse;
    expect(Object.keys(first).sort()).toEqual([
      "access",
      "builtin",
      "search",
      "visualize",
    ]);
    expect(first.access).toMatchObject({ mode: "all", domains: [] });
    expect(first.search.provider).toBeNull();
    expect(first.builtin.map((tool) => tool.name)).toContain("websearch");
    const patch = async (name: string, body: unknown) =>
      client.call("PATCH", `/api/tools/${name}`, { body });
    const listed = await patch("web", {
      mode: "listed",
      domains: [" EXAMPLE.test. ", "example.test", "bücher.test"],
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as ToolsResponse;
    expect(listedBody.access).toMatchObject({
      mode: "listed",
      domains: ["example.test", "xn--bcher-kva.test"],
    });
    for (const mode of ["off", "all", "listed"] as WebAccessMode[]) {
      const answer = await patch("web", { mode });
      expect(answer.status).toBe(200);
      const body = (await answer.json()) as ToolsResponse;
      expect(body.access.domains).toEqual(listedBody.access.domains);
      expect(body.visualize).toEqual(first.visualize);
    }
    for (const provider of ["exa", "firecrawl", "tavily", null]) {
      const answer = await patch("websearch", { provider });
      expect(answer.status).toBe(200);
      expect((await answer.json()).search.provider).toBe(provider);
    }
    const visual = await patch("visualize", { enabled: false, hosts: [] });
    expect(visual.status).toBe(200);
    expect((await visual.json()).visualize).toMatchObject({
      enabled: false,
      hosts: [],
    });
  } finally {
    await app.shutdown();
    app.db.close();
  }
});

test("tools PATCH refuses invalid names, fields, modes and domain lists", async () => {
  const app = await testApp({ adminPassword: "initial-password" });
  const client = app.client();
  try {
    await client.login("admin", "initial-password");
    for (const [name, body] of [
      ["webfetch", { enabled: true }],
      ["websearch", { enabled: true }],
      ["websearch", { provider: "unknown" }],
      ["websearch", { provider: false }],
      ["websearch", { domains: [] }],
      ["web", { enabled: true }],
      ["web", { provider: null }],
      ["web", { hosts: [] }],
      ["web", { mode: "other" }],
      ["web", { mode: null }],
      ["web", { mode: "listed" }],
      ["web", { mode: "listed", domains: [] }],
      ["web", { mode: "listed", domains: [" "] }],
      ["web", { domains: "*.example.test".split("\n") }],
      ["web", { domains: ["https://example.test"] }],
      ["web", { domains: ["example.test:80"] }],
      ["web", { domains: [false] }],
      ["web", { domains: "example.test" }],
      ["web", { domains: null }],
      [
        "web",
        { domains: Array.from({ length: 201 }, (_, i) => `host${i}.test`) },
      ],
      ["web", {}],
      ["visualize", { mode: "off" }],
      ["visualize", { provider: null }],
    ] as const) {
      const response = await client.call("PATCH", `/api/tools/${name}`, {
        body,
      });
      expect(response.status, `${name} ${JSON.stringify(body)}`).toBe(400);
      if (name === "web" && "mode" in body && body.mode === "listed") {
        expect(await response.json()).toMatchObject({
          error: "list at least one host",
        });
      }
    }
    expect(
      (
        await client.call("PATCH", "/api/tools/web", {
          body: { mode: "listed", domains: ["example.test"] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await client.call("PATCH", "/api/tools/web", {
          body: { domains: [] },
        })
      ).status,
    ).toBe(400);
  } finally {
    await app.shutdown();
    app.db.close();
  }
});
