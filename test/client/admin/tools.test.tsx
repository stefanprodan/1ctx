// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools page's model: the unit each limit is typed in and the
// conversion both ways, the range check in the page's words, the
// draft and what a Save collects, the search lines; the entity that
// loads both routes and replaces what it holds on a write; and the
// page rendered over the rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { onPage } from "../../../src/client/app/Rail.model.ts";
import { path } from "../../../src/client/app/router.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  limits,
  loadTools,
  patchTool,
  saveLimits,
  tools,
  toolsError,
} from "../../../src/client/data/tools.ts";
import { firstSentence } from "../../../src/client/lib/format.ts";
import { ToolRow } from "../../../src/client/views/admin/ToolRow.tsx";
import {
  ACCESS_WORDS,
  collect,
  DOMAINS_HINT,
  defaultLine,
  defaultsOf,
  dirty,
  displayOf,
  domainsFieldOf,
  domainsOf,
  draftOf,
  jsonLines,
  keyLine,
  LIMIT_WORDS,
  problem,
  read,
  searchLine,
  seedOf,
  show,
  TOOLS_TABS,
  toolsTab,
  totalTokens,
  WHEN_WORDS,
  withSaved,
} from "../../../src/client/views/admin/Tools.model.ts";
import { Tools } from "../../../src/client/views/admin/Tools.tsx";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import type { LimitRow } from "../../../src/shared/contracts/limit.ts";
import type {
  BuiltinToolSummary,
  SearchState,
  WebToolSummary,
} from "../../../src/shared/contracts/tool.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";
import type { WebAccess } from "../../../src/shared/web.ts";
import { LIMIT_NAMES } from "../../../src/shared/words.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
};

const row = (changes: Partial<LimitRow>): LimitRow => ({
  name: "rounds",
  value: 100,
  default: 100,
  min: 1,
  max: 500,
  unit: "count",
  scope: "send",
  changedAt: null,
  ...changes,
});
const rounds = row({});
const toolMs = row({
  name: "toolMs",
  value: 600_000,
  default: 600_000,
  min: 10_000,
  max: 3_600_000,
  unit: "ms",
});
const timeout = row({
  name: "callTimeoutMs",
  value: 1500,
  default: 20_000,
  min: 1000,
  max: 600_000,
  unit: "ms",
  scope: "call",
  changedAt: 5,
});
const resultBytes = row({
  name: "resultBytes",
  value: 2 * 1024 * 1024,
  default: 2 * 1024 * 1024,
  min: 64 * 1024,
  max: 32 * 1024 * 1024,
  unit: "bytes",
});
const searchBody = row({
  name: "searchBodyBytes",
  value: 512 * 1024,
  default: 1024 * 1024,
  min: 64 * 1024,
  max: 32 * 1024 * 1024,
  unit: "bytes",
  scope: "call",
  changedAt: 5,
});
const cut = row({
  name: "resultCut",
  value: 50_000,
  default: 50_000,
  min: 1000,
  max: 500_000,
  unit: "chars",
  scope: "call",
});
const reserve = row({
  name: "contextReserve",
  value: 20_000,
  default: 20_000,
  min: 1000,
  max: 200_000,
  unit: "tokens",
  scope: "send",
});
const runsPerUser = row({
  name: "runsPerUser",
  value: 4,
  default: 4,
  min: 1,
  max: 32,
  unit: "count",
  scope: "runs",
});
const maxVisuals = row({
  name: "maxVisuals",
  value: 2,
  default: 2,
  min: 1,
  max: 10,
  unit: "count",
  scope: "visuals",
});
const rows = [
  rounds,
  toolMs,
  resultBytes,
  timeout,
  searchBody,
  cut,
  reserve,
  runsPerUser,
  maxVisuals,
];

const html =
  '<div class="md-block" data-lang="json"><div class="md-block-head">' +
  '<span class="md-block-lang">json</span><button type="button" ' +
  'class="md-copy">Copy</button></div><pre class="md-pre">' +
  '<code class="md-block-code"><span class="hljs-punctuation">' +
  "{}</span></code></pre></div>";
const time: BuiltinToolSummary = {
  name: "datetime",
  description: "The current date and time in a timezone. Ask before math.",
  parameters: { type: "object", properties: {} },
  parametersHtml: html,
  tokens: 96,
  when: "always",
  names: false,
  variant: null,
};
const fetchTool: WebToolSummary = {
  name: "visualize",
  description: "Draw a visual in the chat. It runs in a frame.",
  parameters: { type: "object", properties: {} },
  parametersHtml: html,
  tokens: 2716,
  enabled: true,
  hosts: [],
  updatedAt: 0,
};
const access: WebAccess = { mode: "all", domains: [], updatedAt: 0 };
const body = (visualize = fetchTool, web = access): ToolsResponse => ({
  builtin: [time],
  access: web,
  search,
  visualize,
});
const search: SearchState = {
  provider: "exa",
  keys: { exa: true, firecrawl: false, tavily: false },
};

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  me.value = admin;
  tools.value = null;
  limits.value = null;
  toolsError.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the limit words and units", () => {
  test.serial("every name has its words", () => {
    for (const name of LIMIT_NAMES) {
      expect(LIMIT_WORDS[name].label).not.toBe("");
      expect(LIMIT_WORDS[name].text).not.toBe("");
    }
  });

  test.serial(
    "a millisecond cap is typed in seconds, bytes in KB or MB",
    () => {
      expect(displayOf(rounds)).toEqual({ word: "", factor: 1 });
      expect(displayOf(toolMs).word).toBe("s");
      expect(displayOf(resultBytes).word).toBe("MB");
      expect(displayOf(searchBody).word).toBe("MB");
      expect(displayOf(cut).word).toBe("chars");
      expect(displayOf(reserve)).toEqual({ word: "tokens", factor: 1 });
      expect(show(toolMs, 600_000)).toBe("600");
      expect(show(timeout, 1500)).toBe("1.5");
      expect(show(resultBytes, 2 * 1024 * 1024)).toBe("2");
      expect(show(searchBody, 512 * 1024)).toBe("0.5");
      expect(show(rounds, 100)).toBe("100");
    },
  );

  test.serial("what is typed comes back whole in the runner's units", () => {
    expect(read(toolMs, "0.5")).toBe(500);
    expect(read(resultBytes, "1.5")).toBe(1_572_864);
    expect(read(rounds, " 12 ")).toBe(12);
    expect(read(timeout, show(timeout, 1001))).toBe(1001);
    expect(read(resultBytes, show(resultBytes, resultBytes.min))).toBe(
      resultBytes.min,
    );
    expect(read(rounds, "")).toBeNull();
    expect(read(rounds, "ten")).toBeNull();
    expect(read(rounds, "-1")).toBeNull();
  });

  test.serial("the range check speaks the page's unit", () => {
    expect(problem(rounds, "0")).toBe("Rounds must be from 1 to 500");
    expect(problem(toolMs, "5")).toBe("Tool time must be from 10 to 3600 s");
    expect(problem(resultBytes, "64")).toBe(
      "Result bytes must be from 0.0625 to 32 MB",
    );
    expect(problem(rounds, "x")).toBe("Rounds needs a number");
    expect(problem(rounds, "500")).toBeNull();
  });

  test.serial("the draft, what a Save collects and what is dirty", () => {
    const draft = draftOf(rows);
    expect(draft.toolMs).toBe("600");
    expect(draft.callTimeoutMs).toBe("1.5");
    expect(dirty(rows, draft)).toBe(false);
    expect(collect(rows, draft) as unknown).toEqual({
      values: {
        rounds: 100,
        toolMs: 600_000,
        resultBytes: 2 * 1024 * 1024,
        callTimeoutMs: 1500,
        searchBodyBytes: 512 * 1024,
        resultCut: 50_000,
        contextReserve: 20_000,
        runsPerUser: 4,
        maxVisuals: 2,
      },
    });
    const edited = { ...draft, rounds: "501" };
    expect(dirty(rows, edited)).toBe(true);
    expect(collect(rows, edited)).toEqual({
      problem: "Rounds must be from 1 to 500",
      field: "rounds",
    });
    expect(defaultLine(timeout)).toBe("default 20 s");
    expect(defaultLine(searchBody)).toBe("default 1 MB");
    expect(defaultLine(rounds)).toBe("default 100");
  });

  test.serial("a scope's save carries the other scope's saved values", () => {
    const sent = withSaved(rows, "call", {
      callTimeoutMs: 2000,
      searchBodyBytes: 1024 * 1024,
      resultCut: 40_000,
    });
    expect(sent).toMatchObject({
      rounds: 100,
      toolMs: 600_000,
      callTimeoutMs: 2000,
      searchBodyBytes: 1024 * 1024,
      resultCut: 40_000,
    });
    const reset = withSaved(
      rows,
      "call",
      defaultsOf(rows.filter((r) => r.scope === "call")),
    );
    expect(reset.callTimeoutMs).toBe(20_000);
    expect(reset.searchBodyBytes).toBe(1024 * 1024);
    expect(withSaved(rows, "send", { rounds: 3 }).callTimeoutMs).toBe(1500);
    expect(withSaved(rows, "runs", { runsPerUser: 2 })).toMatchObject({
      runsPerUser: 2,
      rounds: 100,
      callTimeoutMs: 1500,
    });
    expect(totalTokens([{ tokens: 96 }, { tokens: 2716 }])).toBe(2812);
    // another form's save moves only the change times: no re-seed
    expect(seedOf([{ ...timeout, changedAt: 99 }])).toBe(seedOf([timeout]));
    expect(seedOf([{ ...timeout, value: 2000 }])).not.toBe(seedOf([timeout]));
  });

  test.serial("the search lines and the first sentence", () => {
    expect(keyLine("exa", true)).toBe("search-exa.key present");
    expect(keyLine("firecrawl", false)).toBe("search-firecrawl.key keyless");
    expect(searchLine(search, "all")).toBe("websearch runs on exa.");
    expect(searchLine({ ...search, provider: "firecrawl" }, "listed")).toBe(
      "websearch runs on firecrawl keyless. " +
        "Add search-firecrawl.key for a higher rate.",
    );
    expect(searchLine({ ...search, provider: null }, "all")).toBe(
      "websearch is not offered.",
    );
    expect(searchLine(search, "off")).toBe(
      "Web access is off. websearch is not offered.",
    );
    expect(firstSentence(time.description)).toBe(
      "The current date and time in a timezone.",
    );
    expect(firstSentence("no end")).toBe("no end");
  });
});

describe("the domains box", () => {
  test("gives the sorted hosts a save sends", () => {
    expect(domainsOf("GitHub.com\n\n docs.example.com \n")).toEqual({
      domains: ["docs.example.com", "github.com"],
    });
  });

  test("an empty box and a line that is not a host are the field's words", () => {
    expect(domainsOf(" \n")).toEqual({ error: "List at least one host." });
    expect(domainsOf("github.com\n*.github.com")).toEqual({
      error: "Line 2, *.github.com, is not a host name.",
    });
    expect(domainsOf("https://github.com")).toEqual({
      error: "Line 1, https://github.com, is not a host name.",
    });
  });

  test("a refusal about hosts belongs to the box", () => {
    expect(domainsFieldOf("domains line 2 is not a host name")).toBe("domains");
    expect(domainsFieldOf("list at least one host")).toBe("domains");
    expect(domainsFieldOf("forbidden")).toBeUndefined();
  });
});

describe("the tools entity", () => {
  test.serial("loads both routes and keeps a failure", async () => {
    answer = (url) =>
      url === "/api/tools"
        ? Response.json(body())
        : Response.json({ limits: rows });
    await loadTools();
    expect(tools.value?.builtin[0]?.name).toBe("datetime");
    expect(tools.value?.visualize.name).toBe("visualize");
    expect(limits.value?.length).toBe(rows.length);
    answer = () => Response.json({ error: "nope" }, { status: 500 });
    await loadTools();
    expect(toolsError.value).toEqual({ words: "nope", status: 500 });
  });

  test.serial(
    "a write replaces what it holds with the server's rows",
    async () => {
      const calls: { url: string; method?: string; body?: string }[] = [];
      answer = (url, init) => {
        calls.push({ url, method: init?.method, body: init?.body as string });
        if (url.startsWith("/api/tools/")) {
          return Response.json(body({ ...fetchTool, enabled: false }));
        }
        return Response.json({
          limits: [{ ...rounds, value: 3, changedAt: 9 }],
        });
      };
      await patchTool("visualize", { enabled: false });
      expect(tools.value?.visualize.enabled).toBe(false);
      expect(calls[0]).toMatchObject({
        url: "/api/tools/visualize",
        method: "PATCH",
        body: '{"enabled":false}',
      });
      await saveLimits({ values: { rounds: 3 } as never });
      expect(limits.value?.[0]?.value).toBe(3);
      expect(calls.map((c) => c.method)).toEqual(["PATCH", "PUT"]);
    },
  );

  test.serial(
    "an earlier write answering last does not undo a later one",
    async () => {
      const pending: Array<() => void> = [];
      answer = (_url, init) => {
        const enabled = JSON.parse(init?.body as string).enabled as boolean;
        return Response.json(body({ ...fetchTool, enabled }));
      };
      const realAnswer = answer;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        await new Promise<void>((release) => pending.push(release));
        return realAnswer(url, init);
      }) as unknown as typeof fetch;
      const first = patchTool("visualize", { enabled: false });
      const second = patchTool("visualize", { enabled: true });
      while (pending.length < 2) await Promise.resolve();
      pending[1]();
      await second;
      expect(tools.value?.visualize.enabled).toBe(true);
      pending[0]();
      await first;
      expect(tools.value?.visualize.enabled).toBe(true);
    },
  );

  test.serial("the entities go with the signed-in user", () => {
    tools.value = body();
    me.value = { ...admin, id: "u2" };
    expect(tools.value).toBeNull();
  });
});

describe("the page", () => {
  test.serial("the tab is the address, and Tools stays lit on it", () => {
    expect(toolsTab("/admin/tools")).toBe("builtin");
    expect(toolsTab("/admin/tools/web")).toBe("web");
    expect(toolsTab("/admin/tools/visuals")).toBe("visuals");
    expect(toolsTab("/admin/tools/limits")).toBe("limits");
    expect(TOOLS_TABS.map((t) => t.label)).toEqual([
      "Built-in",
      "Web",
      "Visuals",
      "Limits",
    ]);
    expect(onPage("/admin/tools/web", "/admin/tools")).toBe(true);
    expect(onPage("/admin/tools", "/admin/tools")).toBe(true);
    expect(onPage("/admin/toolsx", "/admin/tools")).toBe(false);
    expect(WHEN_WORDS.always).not.toBe("");
  });

  test("an open row names the description and counts the schema's lines", () => {
    const html = render(<ToolRow tool={time} open onToggle={() => {}} />);
    expect(html).toContain('<div class="label">Description</div>');
    expect(html).not.toContain("Description for agents");
    // a short schema is not cut: no fade, no Show all
    expect(html).toContain('class="fold fold-inset fold-framed"');
    expect(html).not.toContain("fold-more");
    expect(jsonLines({ type: "object", properties: {} })).toBe(4);
    expect(jsonLines({})).toBe(1);
  });

  test("memory_edit says when each of its two texts is sent", () => {
    const edit: BuiltinToolSummary = {
      ...time,
      name: "memory_edit",
      description: "Save to the project's memory.",
      when: "memory",
      variant: { description: "Update this automation's note.", tokens: 40 },
    };
    const html = render(<ToolRow tool={edit} open onToggle={() => {}} />);
    expect(html).toContain("Sent in every chat, over the project's memory.");
    expect(html).toContain(
      "Description for an automation's own memory, 40 tokens",
    );
    expect(html).toContain(
      "Sent in the step after a run that updates its own memory.",
    );
    expect(html.indexOf("Save to the project")).toBeLessThan(
      html.indexOf("Update this automation"),
    );
  });

  test.serial("Built-in renders the rows with tokens and no switch", () => {
    tools.value = body();
    limits.value = rows;
    path.value = "/admin/tools";
    const html = render(<Tools />);
    expect(html).toContain('class="tabs"');
    expect(html).toContain("Built-in");
    expect(html).toContain("datetime");
    expect(html).toContain("The current date and time in a timezone.");
    expect(html).toContain("96 tokens");
    expect(html).toMatch(/rows-hint[^>]*>96 tokens/);
    // the admin rows' own pieces: the name over the sentence, the meta
    expect(html).toContain(
      '<span class="rows-name rows-name-mono"><span class="cut">datetime',
    );
    expect(html).toContain(
      '<span class="rows-sub">The current date and time in a timezone.',
    );
    expect(html).toContain('<span class="rows-meta">96 tokens');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("webfetch");
    expect(html).not.toContain("md-pre");
    expect(html).not.toContain("Per turn");
  });

  test.serial("Web renders web access and the providers", () => {
    tools.value = body();
    limits.value = rows;
    path.value = "/admin/tools/web";
    const html = render(<Tools />);
    // no row and no switch for the web tools, visualize on its own tab
    expect(html).not.toContain("webfetch");
    expect(html).not.toContain("visualize");
    expect(html).not.toContain('role="switch"');
    // the modes in the card's head, the picked one pressed, one line under
    expect(html).toMatch(
      /Web access<\/span><nav class="seg seg-small rows-filters"/,
    );
    expect(html).toMatch(/seg-on" aria-pressed="true">All domains/);
    expect(html).toContain(ACCESS_WORDS.all);
    expect(html).not.toContain('name="domains"');
    // None comes first among the providers
    expect(html.indexOf('value="none"')).toBeLessThan(
      html.indexOf('value="exa"'),
    );
    expect(html).not.toContain("datetime");
    expect(html).toContain("search-exa.key present");
    expect(html).toContain("search-firecrawl.key keyless");
    expect(html).toContain("search-tavily.key keyless");
    expect(html).not.toContain("rows-meta-bad");
    expect(html).toContain("websearch runs on exa.");
    expect(html).not.toContain("Per turn");
  });

  test.serial("Listed domains shows the stored hosts in the box", () => {
    tools.value = body(fetchTool, {
      mode: "listed",
      domains: ["docs.example.com", "github.com"],
      updatedAt: 0,
    });
    limits.value = rows;
    path.value = "/admin/tools/web";
    const html = render(<Tools />);
    expect(html).toMatch(/seg-on" aria-pressed="true">Listed domains/);
    expect(html).toContain(ACCESS_WORDS.listed);
    expect(html).toMatch(
      /<textarea name="domains"[^>]*>docs\.example\.com\ngithub\.com</,
    );
    expect(html).toContain(DOMAINS_HINT);
    expect(html).toMatch(/foot-label-on">Save</);
    // nothing to save until the list is edited
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });

  test.serial("Off says so under the providers, a pick kept", () => {
    tools.value = body(fetchTool, { mode: "off", domains: [], updatedAt: 0 });
    limits.value = rows;
    path.value = "/admin/tools/web";
    const html = render(<Tools />);
    expect(html).toContain(ACCESS_WORDS.off);
    expect(html).toContain("Web access is off. websearch is not offered.");
    // visualize is apart from web access
    path.value = "/admin/tools/visuals";
    expect(render(<Tools />)).toContain('aria-label="visualize on"');
  });

  test.serial("Visuals renders three sections: tools, CDNs, limits", () => {
    tools.value = body({ ...fetchTool, hosts: ["https://cdn.example.com"] });
    limits.value = rows;
    path.value = "/admin/tools/visuals";
    const html = render(<Tools />);
    expect(html).not.toContain("rows-card");
    expect(
      [...html.matchAll(/section-title">([^<]+)</g)].map((m) => m[1]),
    ).toEqual(["Tools", "CDNs", "Limits"]);
    expect(html).toContain('section-text">Inline visualizations<');
    // the row in an inset list, its tokens and sub line only from 720 up
    expect(html).toContain('class="rows-list"');
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toContain('aria-checked="true"');
    expect(html).toMatch(/rows-meta-long">2\.72K tokens/);
    expect(html).toContain("rows-sub rows-sub-wide");
    expect(html).toMatch(/section-fact-end">1 of 16/);
    // the CDNs, then the visual limits as text boxes with their units
    expect(html.match(/<form/g)).toHaveLength(2);
    expect(html).toContain('class="section-grid"');
    expect(html).toContain('class="section-number-input"');
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain("section-off");
    expect(html).toContain("Visuals per turn");
    expect(html).toContain('name="maxVisuals"');
    expect(html).not.toContain("Rounds");
    expect(html).toMatch(
      /<textarea name="hosts"[^>]*>https:\/\/cdn\.example\.com</,
    );
    expect(html).not.toContain("Web search");
    expect(html).not.toContain("Per turn");
  });

  test.serial("Limits renders the fields", () => {
    tools.value = body();
    limits.value = rows;
    path.value = "/admin/tools/limits";
    const html = render(<Tools />);
    expect(html).toContain("Per turn");
    expect(html).toContain("Per call");
    expect(html).toContain("Knowledge");
    expect(html).toContain("Scheduled tasks");
    expect(html).toContain("Runs per user");
    expect(html).toContain(">Chats<");
    expect(html.match(/<form/g)).toHaveLength(5);
    expect(html).not.toContain("Visuals per turn");
    expect(html).not.toContain(">Limits</span>");
    expect(html).toContain('inputmode="decimal"');
    expect(html).not.toContain('type="number"');
    expect(html).toContain('value="1.5"');
    expect(html).toContain("default 20 s");
    expect(html).not.toContain("rows-hint");
    expect(html).not.toContain('role="switch"');
    path.value = "/";
  });

  test.serial("says it is loading, then the failure", () => {
    expect(render(<Tools />)).toContain("Loading");
    toolsError.value = {
      words: "the server failed while answering",
      status: 500,
    };
    const html = render(<Tools />);
    expect(html).toContain("The server failed while answering.");
    expect(html).toContain('<span class="code-tag">HTTP 500</span>');
  });
});
