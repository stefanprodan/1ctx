// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import {
  credentials,
  credentialsError,
} from "../../../src/client/data/credentials.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  limits,
  loadWebUsage,
  tools,
  toolsError,
} from "../../../src/client/data/tools.ts";
import {
  ACCESS_WORDS,
  accessBody,
  accessDirty,
  boxRows,
  DOMAINS_HINT,
  DOMAINS_PLACEHOLDER,
  domainsCount,
  domainsText,
  WEB_LIMITS,
  webTab,
} from "../../../src/client/views/admin/WebAccess.model.ts";
import { WebAccess } from "../../../src/client/views/admin/WebAccess.tsx";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import type { LimitRow } from "../../../src/shared/contracts/limit.ts";
import type {
  BuiltinToolSummary,
  SearchState,
} from "../../../src/shared/contracts/tool.ts";
import type { WebAccess as Access } from "../../../src/shared/web.ts";
import {
  admin,
  automationTool,
  emailUser,
} from "../../helpers/client-fixtures.ts";

const tool = (
  name: BuiltinToolSummary["name"],
  tokens: number,
): BuiltinToolSummary => ({
  name,
  description: `The ${name} tool. More words.`,
  parameters: { type: "object", properties: {} },
  parametersHtml: '<pre class="md-pre">{}</pre>',
  tokens,
  when: "web",
  variant: null,
});

const search: SearchState = {
  provider: "exa",
  keys: { exa: true, firecrawl: false, tavily: false },
};

const response = (
  access: Partial<Access> = {},
  changes: Partial<SearchState> = {},
): ToolsResponse => ({
  builtin: [tool("bash", 400), tool("webfetch", 120), tool("websearch", 80)],
  access: { mode: "all", domains: [], updatedAt: 0, ...access },
  search: { ...search, ...changes },
  visualize: {
    name: "visualize",
    description: "Draw.",
    parameters: {},
    parametersHtml: "",
    tokens: 1,
    enabled: true,
    hosts: [],
    updatedAt: 0,
  },
  emailUser: emailUser(),
  automation: automationTool(),
});

const limit = (changes: Partial<LimitRow>): LimitRow => ({
  name: "maxFetches",
  value: 6,
  default: 6,
  min: 0,
  max: 100,
  unit: "count",
  scope: "call",
  changedAt: null,
  ...changes,
});
const rows: LimitRow[] = [
  limit({}),
  limit({ name: "maxSearches", value: 3, default: 3 }),
  limit({
    name: "fetchBodyBytes",
    value: 1024 * 1024,
    default: 2 * 1024 * 1024,
    min: 64 * 1024,
    max: 32 * 1024 * 1024,
    unit: "bytes",
    changedAt: 5,
  }),
  limit({
    name: "searchBodyBytes",
    value: 1024 * 1024,
    default: 1024 * 1024,
    min: 64 * 1024,
    max: 32 * 1024 * 1024,
    unit: "bytes",
  }),
  limit({
    name: "fetchDeadlineMs",
    value: 15_000,
    default: 15_000,
    min: 1000,
    max: 600_000,
    unit: "ms",
  }),
  limit({
    name: "searchDeadlineMs",
    value: 10_000,
    default: 10_000,
    min: 1000,
    max: 600_000,
    unit: "ms",
  }),
  limit({ name: "callTimeoutMs", value: 20_000, default: 20_000 }),
];

describe("the Web access words", () => {
  test("the tab is the address", () => {
    expect(webTab("/admin/config/web")).toBe("general");
    expect(webTab("/admin/config/web/credentials")).toBe("credentials");
  });

  test("the box counts only while Listed domains is picked", () => {
    const saved: Access = {
      mode: "listed",
      domains: ["a.example.com"],
      updatedAt: 0,
    };
    expect(accessDirty("listed", "a.example.com\n", saved)).toBe(false);
    expect(accessDirty("listed", "b.example.com", saved)).toBe(true);
    expect(accessDirty("all", "b.example.com", saved)).toBe(true);
    const all: Access = { ...saved, mode: "all" };
    expect(accessDirty("all", "b.example.com", all)).toBe(false);
  });

  test("Save sends the mode, and the list only when listed", () => {
    expect(accessBody("off", "junk here")).toEqual({ body: { mode: "off" } });
    expect(accessBody("listed", "B.example.com\na.example.com")).toEqual({
      body: { mode: "listed", domains: ["a.example.com", "b.example.com"] },
    });
    expect(accessBody("listed", "")).toEqual({
      error: "List at least one host.",
    });
    expect(accessBody("listed", "http://a/b")).toMatchObject({
      error: expect.stringContaining("Line 1"),
    });
    expect(WEB_LIMITS).toHaveLength(6);
  });

  test("the count is the hosts a save stores, of the most allowed", () => {
    expect(domainsCount("a.example.com\nA.example.com\n\n")).toBe("1 of 200");
    // a box that does not parse counts its lines
    expect(domainsCount("a.example.com\nhttp://x/y")).toBe("2 of 200");
    expect(domainsCount("")).toBe("0 of 200");
  });

  test("the box fits the example, or what is typed when longer", () => {
    expect(boxRows("")).toBe(6);
    expect(boxRows("a.example.com")).toBe(6);
    expect(boxRows(Array(8).fill("a.example.com").join("\n"))).toBe(9);
  });
});

const realFetch = globalThis.fetch;

describe("the Web access page", () => {
  let held: [
    typeof tools.value,
    typeof limits.value,
    typeof credentials.value,
    string,
  ];
  beforeEach(() => {
    // a new user drops the usage an earlier test read
    const was = me.value;
    me.value = admin({ id: "reset" });
    me.value = was;
    held = [tools.value, limits.value, credentials.value, path.value];
    path.value = "/admin/config/web";
  });
  afterEach(() => {
    [tools.value, limits.value, credentials.value, path.value] = held;
    toolsError.value = null;
    globalThis.fetch = realFetch;
  });

  test.serial("General: four cards, three forms, nothing to save", () => {
    tools.value = response();
    limits.value = rows;
    const html = render(<WebAccess />);
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    expect(forms).toHaveLength(3);
    expect(
      [...html.matchAll(/setting-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Access", "Search", "Limits", "Tools"]);
    expect(forms[0]).toContain('aria-pressed="true"');
    expect(forms[1]).toContain('value="exa"');
    expect(forms[2]).toContain(`name="${WEB_LIMITS[0]}"`);
    expect(html.match(/type="submit"[^>]*disabled/g)).toHaveLength(3);
    expect(html).not.toContain("Unsaved changes");
    expect(html).toMatch(/General/);
    expect(html).toContain("Credentials");
    expect(html).toMatch(
      /<button\b(?=[^>]*\bseg-on\b)[^>]*aria-pressed="true"[^>]*>All domains/,
    );
    expect(html).toContain(ACCESS_WORDS.all);
    expect(html).not.toContain('name="domains"');
    expect(html.indexOf('value="none"')).toBeLessThan(
      html.indexOf('value="exa"'),
    );
    expect(html).toMatch(
      /<input\b(?=[^>]*value="exa")(?=[^>]*\bchecked)[^>]*>/,
    );
    expect(html).toContain("search-exa.key present");
    expect(html).toContain("search-tavily.key keyless");
    expect(html).toContain("websearch runs on exa.");
    expect(
      [...forms[2]!.matchAll(/<input\b[^>]*name="([a-zA-Z]+)"/g)].map(
        (m) => m[1],
      ),
    ).toEqual([...WEB_LIMITS]);
    expect(html).not.toContain('name="callTimeoutMs"');
    expect(html).toContain("default 2 MB");
    expect(html).toContain(">webfetch<");
    expect(html).toContain(">websearch<");
    expect(html).not.toContain(">bash<");
    expect(html).toMatch(/setting-count">200 tokens</);
    expect(html).toContain("Last 30 days");
    expect(html).toContain("Loading");
  });

  test.serial("Listed domains shows the saved hosts and their count", () => {
    tools.value = response({
      mode: "listed",
      domains: ["docs.example.com", "github.com"],
    });
    limits.value = rows;
    const html = render(<WebAccess />);
    expect(html).toMatch(/seg-on" aria-pressed="true">Listed domains/);
    expect(html).toContain(ACCESS_WORDS.listed);
    expect(html).toMatch(/setting-count">2 of 200</);
    expect(html).toMatch(
      /<textarea name="domains"[^>]*>docs\.example\.com\ngithub\.com</,
    );
    expect(html).toContain(DOMAINS_HINT);
    // the example is sorted as a save stores it
    expect(DOMAINS_PLACEHOLDER).toBe(
      domainsText(
        (
          accessBody("listed", DOMAINS_PLACEHOLDER) as {
            body: { domains: string[] };
          }
        ).body.domains,
      ),
    );
    expect(html).toContain('placeholder="api.github.com\ncodeload.github.com');
  });

  test.serial("off says what the search line means", () => {
    tools.value = response({ mode: "off" }, { provider: null });
    limits.value = rows;
    const html = render(<WebAccess />);
    expect(html).toContain(ACCESS_WORDS.off);
    expect(html).toContain("Web access is off. websearch is not offered.");
    expect(html).toMatch(/value="none" checked/);
  });

  test.serial("Credentials: the list's card, no count on an empty tab", () => {
    tools.value = response();
    limits.value = rows;
    credentials.value = [];
    path.value = "/admin/config/web/credentials";
    const html = render(<WebAccess />);
    expect(html).toContain("Credentials</a>");
    expect(html).not.toContain("tabs-count");
    // General stays drawn, hidden, so its drafts outlive the look
    expect(html).toContain('class="web-access-cards web-access-away"');
    expect(html).toContain("setting-title");
  });

  test.serial("the credentials' failure fails their tab alone", () => {
    tools.value = response();
    limits.value = rows;
    credentialsError.value = { words: "the list did not load", status: 500 };
    try {
      expect(render(<WebAccess />)).not.toContain("The list did not load.");
      path.value = "/admin/config/web/credentials";
      expect(render(<WebAccess />)).toContain("The list did not load.");
    } finally {
      credentialsError.value = null;
    }
  });

  test.serial(
    "the aside counts the last 30 days, or says it failed",
    async () => {
      tools.value = response();
      limits.value = rows;
      globalThis.fetch = (async () =>
        Response.json({
          since: 0,
          until: 1,
          fetches: 9,
          searches: 4,
          failed: 2,
        })) as unknown as typeof fetch;
      await loadWebUsage();
      const html = render(<WebAccess />);
      expect(html).toMatch(/Fetches<span class="split-strong">9</);
      expect(html).toMatch(/Searches<span class="split-strong">4</);
      expect(html).toMatch(/Failed<span class="split-strong">2</);
      expect(html).toContain('href="/admin/monitor/usage"');
      globalThis.fetch = (async () =>
        Response.json(
          { error: "nope" },
          { status: 500 },
        )) as unknown as typeof fetch;
      await loadWebUsage();
      expect(render(<WebAccess />)).toContain("Did not load.");
    },
  );

  test.serial("says it is loading, then the failure", () => {
    tools.value = null;
    limits.value = null;
    expect(render(<WebAccess />)).toContain("Loading");
    toolsError.value = {
      words: "the server failed while answering",
      status: 500,
    };
    expect(render(<WebAccess />)).toContain(
      "The server failed while answering.",
    );
  });
});
