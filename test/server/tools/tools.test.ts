// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools area: offered() and run() over a fake fetcher and a fake
// secrets port, plus the time formatting and the registry's failed-result
// behavior. No real provider host appears; the suite never reaches a
// network.

import { describe, expect, test } from "bun:test";
import { silent } from "../../../src/server/lib/log.ts";
import type { SkillBody } from "../../../src/server/skills/index.ts";
import {
  dateLine,
  formatCurrentTime,
} from "../../../src/server/tools/builtin/time.ts";
import type { SkillsPort } from "../../../src/server/tools/index.ts";
import { type ToolsArea, toolsArea } from "../../../src/server/tools/index.ts";
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
  return { fetches: 0, searches: 0 };
}

function context(shared: ToolBudget = budget()): ToolContext {
  return {
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

describe("formatCurrentTime", () => {
  test("formats a fixed instant with the requested zone offset", () => {
    expect(formatCurrentTime(now, "Europe/Bucharest")).toEqual({
      timezone: "Europe/Bucharest",
      datetime: "2026-09-08T17:42:10+03:00",
      day_of_week: "Tuesday",
    });
    expect(formatCurrentTime(now, "Asia/Tokyo").datetime).toBe(
      "2026-09-08T23:42:10+09:00",
    );
    expect(formatCurrentTime(now, "America/New_York").datetime).toBe(
      "2026-09-08T10:42:10-04:00",
    );
    expect(dateLine(now, "Europe/Bucharest")).toBe(
      "Today's date: Tuesday, 2026-09-08",
    );
    expect(dateLine(now, "Pacific/Auckland")).toBe(
      "Today's date: Wednesday, 2026-09-09",
    );
  });

  test("names an invalid timezone", () => {
    expect(() => formatCurrentTime(now, "Mars/Olympus")).toThrow(
      'unknown timezone "Mars/Olympus"',
    );
  });
});

describe("offered", () => {
  test("offers time and webfetch always, websearch once chosen", () => {
    expect(
      area()
        .offered(now, "")
        .tools.map((tool) => tool.name),
    ).toEqual(["get_current_time", "webfetch"]);
    expect(area().offered(now, "").search).toBeNull();

    const withExa = area({ exa: "exa-key" }, "exa").offered(now, "");
    expect(withExa.tools.map((tool) => tool.name)).toEqual([
      "get_current_time",
      "webfetch",
      "websearch",
    ]);
    expect(withExa.search).toBe("exa");
    // a chosen provider without its key file still answers, keyless
    expect(area({}, "exa").offered(now, "").search).toBe("exa");
  });

  test.each([...BUILTIN_TOOLS])(
    "does not offer %s when its switch is off",
    (name) => {
      const tools = area({ exa: "e" }, "exa");
      tools.store.setEnabled(name, false, now);
      expect(
        tools.offered(now, "").tools.map((tool) => tool.name),
      ).not.toContain(name);
    },
  );

  test("uses only the chosen provider, whichever keys exist", () => {
    expect(
      area({ exa: "e", firecrawl: "f" }, "firecrawl").offered(now, "").search,
    ).toBe("firecrawl");
    expect(area({ exa: "e" }, "firecrawl").offered(now, "").search).toBe(
      "firecrawl",
    );
    expect(area({ exa: "e" }).offered(now, "").search).toBeNull();
  });

  test("fills {{year}} in the websearch description in the host zone", () => {
    const websearch = area({ exa: "e" }, "exa")
      .offered(now, "")
      .tools.find((tool) => tool.name === "websearch");
    // the host timezone decides the year; both are plausible around the
    // fixed instant, so assert the placeholder is gone and a year is set
    expect(websearch?.description).not.toContain("{{year}}");
    expect(websearch?.description).toMatch(/The current year is 20\d\d\./);

    const fetch = area()
      .offered(now, "")
      .tools.find((tool) => tool.name === "webfetch");
    expect(fetch?.parameters).toMatchObject({
      required: ["url"],
      properties: {
        max_length: { type: "integer", minimum: 1, maximum: 50_000 },
        start_index: { type: "integer", minimum: 0 },
      },
    });
    const time = area()
      .offered(now, "")
      .tools.find((tool) => tool.name === "get_current_time");
    expect(time?.parameters).toMatchObject({ required: ["timezone"] });
  });
});

describe("run", () => {
  test("runs get_current_time and accepts empty arguments as an object", async () => {
    const offered = area().offered(now, "");
    const result = await area().run(
      offered,
      {
        id: "call_1",
        name: "get_current_time",
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

    const empty = await area().run(
      offered,
      { id: "call_2", name: "get_current_time", arguments: "" },
      context(),
    );
    expect(empty).toMatchObject({
      content: "Error: timezone must be a non-empty string",
      error: true,
    });
  });

  test("turns unknown tools, bad JSON and invalid zones into failed results", async () => {
    const offered = area().offered(now, "");
    expect(
      await area().run(
        offered,
        { id: "x", name: "missing", arguments: "{}" },
        context(),
      ),
    ).toEqual({ content: 'Error: tool "missing" not found.', error: true });
    expect(
      await area().run(
        offered,
        { id: "x", name: "get_current_time", arguments: "{" },
        context(),
      ),
    ).toMatchObject({
      error: true,
      content: 'Error: invalid JSON arguments for tool "get_current_time"',
    });
    expect(
      await area().run(
        offered,
        {
          id: "x",
          name: "get_current_time",
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
    const offered = area().offered(now, "");
    expect(
      await area().run(
        offered,
        { id: "x", name: "get_current_time", arguments: "[1,2]" },
        context(),
      ),
    ).toMatchObject({
      error: true,
      content: 'Error: arguments for tool "get_current_time" must be an object',
    });
  });

  test("a switched-off tool named by the model is not run", async () => {
    const tools = area();
    tools.store.setEnabled("webfetch", false, now);
    const offered = tools.offered(now, "");
    const result = await tools.run(
      offered,
      { id: "x", name: "webfetch", arguments: '{"url":"https://x.test"}' },
      context(),
    );
    expect(result).toEqual({
      error: true,
      content: 'Error: tool "webfetch" not found.',
    });
  });

  test("websearch not offered is not run", async () => {
    const noSearch = area().offered(now, "");
    expect(noSearch.search).toBeNull();
    const result = await area().run(
      noSearch,
      { id: "x", name: "websearch", arguments: '{"query":"hi"}' },
      context(),
    );
    expect(result).toMatchObject({
      error: true,
      content: 'Error: tool "websearch" not found.',
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
