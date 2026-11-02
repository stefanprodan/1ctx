// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { Client } from "../../../src/server/provision/client.ts";
import { applyMcpServer } from "../../../src/server/provision/mcp.ts";
import {
  type Inventory,
  preflight,
} from "../../../src/server/provision/parse.ts";
import { testApp } from "../../helpers/app.ts";
import { documents, MCP_URL, network, object } from "./helpers.ts";

const inventory = (existing: Partial<Inventory> = {}): Inventory => ({
  User: [],
  SmtpServer: [],
  Project: ["finops", "research"],
  Credential: [],
  Repository: [],
  Provider: [],
  Decider: [],
  Dictation: [],
  Skill: [],
  McpServer: [],
  Agent: [],
  Tool: ["web", "websearch", "visualize"],
  ...existing,
});

function check(
  docs: ReturnType<typeof documents>,
  existing: Partial<Inventory> = {},
) {
  return preflight(
    docs,
    inventory(existing),
    (_kind, name) => (name === "mcp-markets" ? "markets-key" : null),
    { mode: "all", domains: [] },
    () => ({ caps: DEFAULT_LIMITS, live: [], labels: [] }),
    { key: () => "ok", list: () => [] },
  );
}

const keyed = (spec: Record<string, unknown> = {}) =>
  object("McpServer", "markets", {
    url: MCP_URL,
    keyFrom: "mcp-markets",
    personal: "off",
    ...spec,
  });

describe("McpServer projects preflight", () => {
  test("a keyed create names its projects; a keyless one need not", () => {
    expect(() => check(documents(keyed()))).toThrow(
      "McpServer/markets: spec.projects is required for a new server with a key",
    );
    check(documents(keyed({ projects: "all" })));
    check(documents(keyed({ projects: ["finops"] })));
    check(documents(object("McpServer", "docs", { url: MCP_URL })));
    // and its personal grant
    expect(() =>
      check(
        documents(
          object("McpServer", "markets", {
            url: MCP_URL,
            keyFrom: "mcp-markets",
            projects: "all",
          }),
        ),
      ),
    ).toThrow(
      "McpServer/markets: spec.personal is required for a new server with a key",
    );
    // an update leaves the held scope as it is
    check(documents(keyed()), { McpServer: ["markets"] });
    expect(() => check(documents(keyed({ projects: [] })))).toThrow(
      "spec.projects must be all or name a project with a key",
    );
  });

  test("a list names team projects the instance or the input holds", () => {
    expect(() => check(documents(keyed({ projects: ["personal"] })))).toThrow(
      "spec.projects cannot name a personal project",
    );
    expect(() => check(documents(keyed({ projects: ["nowhere"] })))).toThrow(
      "spec.projects references missing Project/nowhere",
    );
    expect(() => check(documents(keyed({ projects: "some" })))).toThrow(
      "McpServer/markets: spec.projects",
    );
    check(
      documents(
        object("Project", "newteam", { description: "A team project." }),
        keyed({ projects: ["newteam"] }),
      ),
    );
    // a choice names a team project too
    expect(() =>
      check(
        documents(
          keyed({
            projects: "all",
            choices: [{ project: "personal", side: "off" }],
          }),
        ),
      ),
    ).toThrow("spec.choices cannot name a personal project");
    expect(() =>
      check(
        documents(
          keyed({
            projects: "all",
            choices: [{ project: "nowhere", side: "off" }],
          }),
        ),
      ),
    ).toThrow("spec.choices references missing Project/nowhere");
  });
});

describe("McpServer projects apply", () => {
  test("applied, omitted keeps an update's scope, a keyless create is all", async () => {
    const fake = network();
    const app = await testApp({
      activate: false,
      fetcher: fake.fetcher,
      secrets: { "mcp-markets": "markets-key" },
    });
    const ignore = () => {};
    try {
      await app.provision.apply(
        documents(
          object("Project", "finops", { description: "A team project." }),
          object("Project", "research", { description: "A team project." }),
          keyed({ projects: ["finops"] }),
          object("McpServer", "docs", { url: MCP_URL }),
        ),
        ignore,
      );
      const byName = (name: string) =>
        app.mcp.list().find((row) => row.name === name)!;
      const id = (name: string) =>
        app.projects
          .teamProjectIds()
          .find((projectId) => app.projects.byId(projectId)?.name === name)!;
      expect(byName("markets")).toMatchObject({
        scope: "projects",
        projectIds: [id("finops")],
      });
      expect(byName("docs")).toMatchObject({ scope: "all", projectIds: [] });

      // omitted, the narrowed scope stays; the same list is no write
      expect(
        await app.provision.apply(
          documents(keyed({ readPatterns: ["*"] })),
          ignore,
        ),
      ).toEqual({ created: 0, updated: 1, unchanged: 0 });
      expect(byName("markets").projectIds).toEqual([id("finops")]);
      expect(
        await app.provision.apply(
          documents(keyed({ projects: ["finops"] })),
          ignore,
        ),
      ).toEqual({ created: 0, updated: 0, unchanged: 1 });

      await app.provision.apply(
        documents(keyed({ projects: ["finops", "research"] })),
        ignore,
      );
      expect(byName("markets").projectIds.sort()).toEqual(
        [id("finops"), id("research")].sort(),
      );
      await app.provision.apply(documents(keyed({ projects: "all" })), ignore);
      expect(byName("markets")).toMatchObject({ scope: "all", projectIds: [] });
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });
});

describe("McpServer personal and choices apply", () => {
  test("a server, its grant and its choices made in one file; omitted leaves them", async () => {
    const fake = network();
    const app = await testApp({
      activate: false,
      fetcher: fake.fetcher,
      secrets: { "mcp-markets": "markets-key" },
    });
    const ignore = () => {};
    try {
      const file = documents(
        object("Project", "finops", { description: "A team project." }),
        object("Project", "research", { description: "A team project." }),
        keyed({
          projects: "all",
          personal: "read",
          write: true,
          choices: [
            { project: "finops", side: "write" },
            { project: "research", side: "off" },
          ],
        }),
      );
      expect(await app.provision.apply(file, ignore)).toMatchObject({
        created: 3,
      });
      const server = app.mcp.list().find((row) => row.name === "markets")!;
      const id = (name: string) =>
        app.projects
          .teamProjectIds()
          .find((projectId) => app.projects.byId(projectId)?.name === name)!;
      expect(server.personal).toBe("read");
      const sides = (name: string) => app.mcp.choices(id(name))?.sides;
      expect(sides("finops")?.get(server.id)).toBe("write");
      expect(sides("research")?.get(server.id)).toBe("off");
      expect(await app.provision.apply(file, ignore)).toEqual({
        created: 0,
        updated: 0,
        unchanged: 3,
      });
      // a choice not named, and personal omitted, stay as they are
      await app.provision.apply(
        documents(
          object("McpServer", "markets", {
            choices: [{ project: "research", side: "read" }],
          }),
        ),
        ignore,
      );
      expect(sides("finops")?.get(server.id)).toBe("write");
      expect(sides("research")?.has(server.id)).toBe(false);
      expect(app.mcp.byId(server.id)?.personal).toBe("read");
      // a choice in a project outside the grant fails the apply
      const failed = await app.provision
        .apply(
          documents(
            keyed({
              projects: ["finops"],
              choices: [{ project: "research", side: "read" }],
            }),
          ),
          ignore,
        )
        .then(
          () => null,
          (error: Error) => error.message,
        );
      expect(failed).toContain("not granted");
    } finally {
      await app.shutdown();
      app.db.close();
    }
  });
});

describe("McpServer projects with a new key", () => {
  test("the scope goes in the endpoint's PATCH, never a second one", async () => {
    const writes: { method: string; path: string; body: unknown }[] = [];
    const api = {
      async call(method: string, path: string, body?: unknown) {
        if (method === "GET" && path === "/api/mcp") {
          return {
            servers: [
              {
                id: "s1",
                name: "markets",
                url: MCP_URL,
                keyName: null,
                read: true,
                write: false,
                instructionsOn: true,
                timeoutMs: null,
                readPatterns: [],
                writePatterns: [],
                excludedPatterns: [],
                scope: "all",
                projects: [],
                personal: "off",
              },
            ],
          };
        }
        if (method === "GET" && path === "/api/projects") {
          return { projects: [{ id: "t1", name: "finops", kind: "team" }] };
        }
        writes.push({ method, path, body });
        return {};
      },
    } as unknown as Client;
    expect(
      await applyMcpServer(api, {
        name: "markets",
        spec: {
          keyFrom: "mcp-markets",
          projects: ["finops"],
          personal: "read",
          write: true,
        },
      }),
    ).toBe("updated");
    expect(writes).toEqual([
      {
        method: "PATCH",
        path: "/api/mcp/s1",
        body: { keyName: "mcp-markets", projects: ["t1"], personal: "read" },
      },
      { method: "PATCH", path: "/api/mcp/s1", body: { write: true } },
    ]);
  });
});
