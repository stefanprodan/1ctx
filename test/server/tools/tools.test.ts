// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools area: offered() and run() over a fake fetcher and a fake
// secrets port, plus the time formatting and the registry's failed-result
// behavior. No real provider host appears; the suite never reaches a
// network.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import { wireTokens } from "../../../src/server/providers/index.ts";
import type { SkillBody } from "../../../src/server/skills/index.ts";
import { formatDatetime } from "../../../src/server/tools/builtin/datetime.ts";
import { builtinCatalog } from "../../../src/server/tools/catalog.ts";
import type { SkillsPort } from "../../../src/server/tools/index.ts";
import {
  CHAT_MEMORY_DESCRIPTION,
  type ToolsArea,
  toolsArea,
} from "../../../src/server/tools/index.ts";
import { TOOL_CAPS } from "../../../src/server/tools/limits.ts";
import type {
  ToolBudget,
  ToolContext,
} from "../../../src/server/tools/types.ts";
import type { OfferedSkill } from "../../../src/shared/contracts/skill.ts";
import {
  BUILTIN_TOOLS,
  type SearchProvider,
} from "../../../src/shared/words.ts";
import { memoryDb } from "../../helpers/db.ts";

const now = Date.UTC(2026, 8, 8, 14, 42, 10);

// a skills port the tools area requires: an empty catalog unless a test
// hands one, and body/file over that catalog. Skill tools are offered
// only when forAgent answers a skill (decision 6)
function skillsPort(offered: OfferedSkill[] = []): SkillsPort {
  const bodies = new Map<string, SkillBody>(
    offered.map((skill) => [
      skill.id,
      {
        id: skill.id,
        name: skill.name,
        compatibility: "",
        body: `Use ${skill.name}.`,
        files: skill.hasFiles ? ["references/a.md"] : [],
      },
    ]),
  );
  return {
    forAgent: () => offered,
    body: (id, name) => {
      const row = bodies.get(id);
      return row && row.name === name ? row : null;
    },
    file: (id, name, path) => {
      const row = bodies.get(id);
      if (!row || row.name !== name || !row.files.includes(path)) return null;
      return `contents of ${path}`;
    },
  };
}

function budget(): ToolBudget {
  return { bashCalls: 0, fetches: 0, searches: 0, visualBytes: 0, visuals: 0 };
}

function context(shared: ToolBudget = budget()): ToolContext {
  return {
    actor: null,
    web: null,
    signal: new AbortController().signal,
    now: () => now,
    budget: shared,
    caps: TOOL_CAPS,
  };
}

function area(
  secrets: Record<string, string> = {},
  provider: SearchProvider | null = null,
  skills: SkillsPort = skillsPort(),
): ToolsArea {
  const tools = toolsArea({
    db: memoryDb(),
    fetcher: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
    secret: (name) => secrets[name] ?? null,
    clock: () => now,
    log: silent,
    version: "vtest",
    render: (md) => md,
    skills,
  });
  if (provider !== null) tools.store.setProvider(provider, now);
  return tools;
}

describe("formatDatetime", () => {
  test("formats a fixed instant with the requested zone offset", () => {
    expect(formatDatetime(now, "Europe/Bucharest")).toEqual({
      timezone: "Europe/Bucharest",
      datetime: "2026-09-08T17:42:10+03:00",
      day_of_week: "Tuesday",
    });
    expect(formatDatetime(now, "Asia/Tokyo").datetime).toBe(
      "2026-09-08T23:42:10+09:00",
    );
    expect(formatDatetime(now, "America/New_York").datetime).toBe(
      "2026-09-08T10:42:10-04:00",
    );
  });

  test("names an invalid timezone", () => {
    expect(() => formatDatetime(now, "Mars/Olympus")).toThrow(
      'unknown timezone "Mars/Olympus"',
    );
  });
});

describe("offered", () => {
  test("offers time, webfetch, visualize and bash, websearch once chosen", () => {
    const plain = area().offered(now, "");
    expect(plain.tools.map((tool) => tool.name)).toEqual([
      "datetime",
      "webfetch",
      "visualize",
      "bash",
    ]);
    expect(plain.search).toBeNull();

    const withExa = area({ "search-exa": "exa-key" }, "exa").offered(now, "");
    expect(withExa.tools.map((tool) => tool.name)).toEqual([
      "datetime",
      "webfetch",
      "websearch",
      "visualize",
      "bash",
    ]);
    expect(withExa.search).toBe("exa");
    // a chosen provider without its key file still answers, keyless
    expect(area({}, "exa").offered(now, "").search).toBe("exa");
  });

  test("offers datetime with no row, since it has no switch", () => {
    const tools = area();
    expect(tools.store.rows().map((row) => row.name)).toEqual([
      "webfetch",
      "websearch",
      "visualize",
      "web",
    ]);
    tools.store.setAccess("off", [], now);
    expect(tools.offered(now, "").tools.map((tool) => tool.name)).toEqual([
      "datetime",
      "visualize",
      "bash",
    ]);
  });

  test.each(["visualize"] as const)(
    "does not offer %s when its switch is off",
    (name) => {
      const tools = area({ "search-exa": "e" }, "exa");
      tools.store.setEnabled(name, false, now);
      expect(
        tools.offered(now, "").tools.map((tool) => tool.name),
      ).not.toContain(name);
    },
  );

  test("uses only the chosen provider, whichever keys exist", () => {
    expect(
      area({ "search-exa": "e", "search-firecrawl": "f" }, "firecrawl").offered(
        now,
        "",
      ).search,
    ).toBe("firecrawl");
    expect(
      area({ "search-exa": "e" }, "firecrawl").offered(now, "").search,
    ).toBe("firecrawl");
    expect(
      area({ "search-firecrawl": "f" }, "tavily").offered(now, "").search,
    ).toBe("tavily");
    expect(area({ "search-exa": "e" }).offered(now, "").search).toBeNull();
  });

  test("fills {{year}} in the websearch description in UTC", () => {
    const websearch = area({ "search-exa": "e" }, "exa")
      .offered(now, "")
      .tools.find((tool) => tool.name === "websearch");
    expect(websearch?.description).not.toContain("{{year}}");
    expect(websearch?.description).toContain("The current year is 2026.");

    const plain = area().offered(now, "").tools;
    const fetch = plain.find((tool) => tool.name === "webfetch");
    expect(fetch?.parameters).toMatchObject({
      required: ["url"],
      properties: {
        max_length: { type: "integer", minimum: 1, maximum: 50_000 },
        start_index: { type: "integer", minimum: 0 },
      },
    });
    const time = plain.find((tool) => tool.name === "datetime");
    expect(time?.parameters).not.toHaveProperty("required");
    expect(time?.parameters).toMatchObject({
      properties: { timezone: { default: "UTC" } },
    });
  });
});

describe("the built-in catalog", () => {
  const catalog = builtinCatalog(now, (md) => md);

  test("lists every built-in by name, each with its tokens", () => {
    expect(catalog.map((tool) => tool.name)).toEqual(
      ([...BUILTIN_TOOLS, "webfetch", "websearch"] as const).toSorted(),
    );
    expect([...BUILTIN_TOOLS]).toEqual([...BUILTIN_TOOLS].sort());
    for (const tool of catalog) {
      expect(tool.tokens).toBeGreaterThan(0);
      expect(tool.tokens).toBe(
        wireTokens([
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ]),
      );
      expect(tool.parametersHtml).toContain("```json");
    }
  });

  test("a schema naming skills or MCP tools lists none", () => {
    const named = catalog.filter((tool) => tool.names).map((t) => t.name);
    expect(named).toEqual(["mcp_call", "mcp_describe", "skill", "skill_file"]);
    for (const tool of catalog.filter((t) => t.names)) {
      expect(
        (tool.parameters as { properties: { name: { enum: string[] } } })
          .properties.name.enum,
      ).toEqual([]);
    }
  });

  test("says when a send carries each, and memory_edit's two texts", () => {
    expect(Object.fromEntries(catalog.map((t) => [t.name, t.when]))).toEqual({
      bash: "knowledge",
      datetime: "always",
      skill: "skills",
      skill_file: "skillFiles",
      mcp_describe: "mcpCatalog",
      mcp_call: "mcpCatalog",
      memory_edit: "memory",
      webfetch: "web",
      websearch: "webSearch",
    });
    const edit = catalog.find((tool) => tool.name === "memory_edit")!;
    expect(edit.description).toBe(CHAT_MEMORY_DESCRIPTION);
    expect(
      (edit.parameters as { properties: { action: { enum: string[] } } })
        .properties.action.enum,
    ).toEqual(["set", "remove"]);
    expect(edit.variant?.description).toContain("this automation's own memory");
    expect(edit.variant?.tokens).toBeGreaterThan(0);
    expect(
      catalog.filter((tool) => tool.variant !== null).map((tool) => tool.name),
    ).toEqual(["memory_edit"]);
  });
});

describe("run", () => {
  // nothing here writes the store, so one area serves every test
  const tools = area();
  const offered = tools.offered(now, "");

  test("runs datetime, in UTC when no timezone is given", async () => {
    const result = await tools.run(
      offered,
      {
        id: "call_1",
        name: "datetime",
        arguments: '{"timezone":"UTC"}',
      },
      context(),
    );
    expect(result.error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      timezone: "UTC",
      datetime: "2026-09-08T14:42:10+00:00",
      day_of_week: "Tuesday",
    });

    const utc = {
      content: JSON.stringify({
        timezone: "UTC",
        datetime: "2026-09-08T14:42:10+00:00",
        day_of_week: "Tuesday",
      }),
      error: false,
    };
    for (const args of ["", "{}", '{"timezone":null}', '{"timezone":""}']) {
      expect(
        await tools.run(
          offered,
          { id: "call_2", name: "datetime", arguments: args },
          context(),
        ),
      ).toEqual(utc);
    }
    expect(
      await tools.run(
        offered,
        { id: "call_3", name: "datetime", arguments: '{"timezone":3}' },
        context(),
      ),
    ).toMatchObject({
      content: "Error: timezone must be a string",
      error: true,
    });
  });

  test("turns unknown tools, bad JSON and invalid zones into failed results", async () => {
    expect(
      await tools.run(
        offered,
        { id: "x", name: "missing", arguments: "{}" },
        context(),
      ),
    ).toEqual({ content: 'Error: tool "missing" not found.', error: true });
    expect(
      await tools.run(
        offered,
        { id: "x", name: "datetime", arguments: "{" },
        context(),
      ),
    ).toMatchObject({
      error: true,
      content: 'Error: invalid JSON arguments for tool "datetime"',
    });
    expect(
      await tools.run(
        offered,
        {
          id: "x",
          name: "datetime",
          arguments: '{"timezone":"Not/AZone"}',
        },
        context(),
      ),
    ).toMatchObject({
      error: true,
      content: 'Error: unknown timezone "Not/AZone"',
    });
  });

  test("rejects arguments that are not a JSON object", async () => {
    expect(
      await tools.run(
        offered,
        { id: "x", name: "datetime", arguments: "[1,2]" },
        context(),
      ),
    ).toMatchObject({
      error: true,
      content: 'Error: arguments for tool "datetime" must be an object',
    });
  });
});

describe("skill tools from the required skills port", () => {
  const catalog: OfferedSkill[] = [
    { id: "s1", name: "ops", description: "ops", hasFiles: false },
    { id: "s2", name: "runbooks", description: "runbooks", hasFiles: true },
  ];

  test("no skill tools are offered when the agent has none", () => {
    const names = area()
      .offered(now, "agent")
      .tools.map((tool) => tool.name);
    expect(names).not.toContain("skill");
    expect(names).not.toContain("skill_file");
  });

  test("offers skill with the catalog enum and skill_file when a skill has files", () => {
    const tools = area({}, null, skillsPort(catalog)).offered(now, "agent");
    const skill = tools.tools.find((tool) => tool.name === "skill")!;
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "datetime",
      "webfetch",
      "visualize",
      "bash",
      "skill",
      "skill_file",
    ]);
    expect(
      (
        skill.parameters as {
          properties: { name: { enum: string[] } };
        }
      ).properties.name.enum,
    ).toEqual(["ops", "runbooks"]);
    expect(tools.tools.some((tool) => tool.name === "skill_file")).toBeTrue();
    expect(tools.skills.skills.map((skill) => skill.name)).toEqual([
      "ops",
      "runbooks",
    ]);
  });

  test("omits skill_file when no offered skill has files", () => {
    const tools = area({}, null, skillsPort([catalog[0]!])).offered(
      now,
      "agent",
    );
    expect(tools.tools.some((tool) => tool.name === "skill")).toBeTrue();
    expect(tools.tools.some((tool) => tool.name === "skill_file")).toBeFalse();
  });

  test("run() answers a skill call from the offered snapshot and port", async () => {
    const tools = area({}, null, skillsPort(catalog));
    const offered = tools.offered(now, "agent");
    const loaded = await tools.run(
      offered,
      { id: "c1", name: "skill", arguments: '{"name":"ops"}' },
      context(),
    );
    expect(loaded.error).toBeFalse();
    expect(loaded.content).toContain('<skill_content name="ops">');
    expect(loaded.content).toContain("Use ops.");

    const file = await tools.run(
      offered,
      {
        id: "c2",
        name: "skill_file",
        arguments: '{"name":"runbooks","path":"references/a.md"}',
      },
      context(),
    );
    expect(file.error).toBeFalse();
    expect(file.content).toBe("contents of references/a.md");

    const missing = await tools.run(
      offered,
      {
        id: "c3",
        name: "skill_file",
        arguments: '{"name":"runbooks","path":"nope.md"}',
      },
      context(),
    );
    expect(missing.error).toBeTrue();
    expect(missing.content).toContain("references/a.md");
  });

  test("run() fails a skill the offered snapshot does not hold", async () => {
    const tools = area({}, null, skillsPort(catalog));
    const offered = tools.offered(now, "agent");
    const gone = await tools.run(
      offered,
      { id: "c4", name: "skill", arguments: '{"name":"missing"}' },
      context(),
    );
    expect(gone.error).toBeTrue();
    expect(gone.content).toContain("no longer available");
  });
});
