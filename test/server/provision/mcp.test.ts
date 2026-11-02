// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
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
