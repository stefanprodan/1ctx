// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools page's model: the unit each limit is typed in and the
// conversion both ways, the range check in the page's words, the
// draft and what a Save collects, the search lines; the entity that
// loads both routes and replaces what it holds on a write; the rail
// entry; and the page rendered over the rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { railRows } from "../../../src/client/app/routes.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  limits,
  loadTools,
  patchTool,
  resetLimits,
  saveLimits,
  tools,
  toolsError,
} from "../../../src/client/data/tools.ts";
import {
  collect,
  defaultLine,
  dirty,
  displayOf,
  draftOf,
  firstSentence,
  keyLine,
  LIMIT_WORDS,
  problem,
  read,
  searchLine,
  show,
} from "../../../src/client/views/admin/Tools.model.ts";
import { Tools } from "../../../src/client/views/admin/Tools.tsx";
import type { LimitRow } from "../../../src/shared/contracts/limit.ts";
import type {
  SearchState,
  ToolSummary,
} from "../../../src/shared/contracts/tool.ts";
import type { UserSummary } from "../../../src/shared/contracts/user.ts";
import { LIMIT_NAMES } from "../../../src/shared/words.ts";

const admin: UserSummary = {
  id: "u1",
  username: "admin",
  fullName: "Administrator",
  role: "admin",
};

const row = (changes: Partial<LimitRow>): LimitRow => ({
  name: "rounds",
  value: 10,
  default: 10,
  min: 1,
  max: 50,
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
const rows = [rounds, toolMs, resultBytes, timeout, searchBody, cut];

const time: ToolSummary = {
  name: "get_current_time",
  description: "The current date and time in a timezone. Ask before math.",
  parameters: { type: "object", properties: {} },
  parametersHtml:
    '<div class="md-block" data-lang="json"><div class="md-block-head">' +
    '<span class="md-block-lang">json</span><button type="button" ' +
    'class="md-copy">Copy</button></div><pre class="md-pre">' +
    '<code class="md-block-code"><span class="hljs-punctuation">' +
    "{}</span></code></pre></div>",
  enabled: true,
  updatedAt: 0,
};
const search: SearchState = {
  provider: "exa",
  keys: { exa: true, firecrawl: false },
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
  test("every name has its words", () => {
    for (const name of LIMIT_NAMES) {
      expect(LIMIT_WORDS[name].label).not.toBe("");
      expect(LIMIT_WORDS[name].text).not.toBe("");
    }
  });

  test("a millisecond cap is typed in seconds, bytes in KB or MB", () => {
    expect(displayOf(rounds)).toEqual({ word: "", factor: 1 });
    expect(displayOf(toolMs).word).toBe("s");
    expect(displayOf(resultBytes).word).toBe("MB");
    expect(displayOf(searchBody).word).toBe("MB");
    expect(displayOf(cut).word).toBe("chars");
    expect(show(toolMs, 600_000)).toBe("600");
    expect(show(timeout, 1500)).toBe("1.5");
    expect(show(resultBytes, 2 * 1024 * 1024)).toBe("2");
    expect(show(searchBody, 512 * 1024)).toBe("0.5");
    expect(show(rounds, 10)).toBe("10");
  });

  test("what is typed comes back whole in the runner's units", () => {
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

  test("the range check speaks the page's unit", () => {
    expect(problem(rounds, "0")).toBe("Rounds is 1 to 50");
    expect(problem(toolMs, "5")).toBe("Tool time is 10 to 3600 s");
    expect(problem(resultBytes, "64")).toBe("Result bytes is 0.0625 to 32 MB");
    expect(problem(rounds, "x")).toBe("Rounds needs a number");
    expect(problem(rounds, "50")).toBeNull();
  });

  test("the draft, what a Save collects and what is dirty", () => {
    const draft = draftOf(rows);
    expect(draft.toolMs).toBe("600");
    expect(draft.callTimeoutMs).toBe("1.5");
    expect(dirty(rows, draft)).toBe(false);
    expect(collect(rows, draft) as unknown).toEqual({
      values: {
        rounds: 10,
        toolMs: 600_000,
        resultBytes: 2 * 1024 * 1024,
        callTimeoutMs: 1500,
        searchBodyBytes: 512 * 1024,
        resultCut: 50_000,
      },
    });
    const edited = { ...draft, rounds: "200" };
    expect(dirty(rows, edited)).toBe(true);
    expect(collect(rows, edited)).toEqual({ problem: "Rounds is 1 to 50" });
    expect(defaultLine(timeout)).toBe("default 20 s");
    expect(defaultLine(searchBody)).toBe("default 1 MB");
    expect(defaultLine(rounds)).toBe("default 10");
  });

  test("the search lines and the first sentence", () => {
    expect(keyLine("exa", true)).toBe("exa.key present");
    expect(keyLine("firecrawl", false)).toBe("firecrawl.key keyless");
    expect(searchLine(search)).toBe("websearch runs on exa.");
    expect(searchLine({ ...search, provider: "firecrawl" })).toBe(
      "websearch runs on firecrawl without a key; firecrawl.key in the secrets directory raises the rate.",
    );
    expect(searchLine({ ...search, provider: null })).toContain("Choose");
    expect(firstSentence(time.description)).toBe(
      "The current date and time in a timezone.",
    );
    expect(firstSentence("no end")).toBe("no end");
  });
});

describe("the tools entity", () => {
  test("loads both routes and keeps a failure", async () => {
    answer = (url) =>
      url === "/api/tools"
        ? Response.json({ tools: [time], search })
        : Response.json({ limits: rows });
    await loadTools();
    expect(tools.value?.tools[0]?.name).toBe("get_current_time");
    expect(limits.value?.length).toBe(rows.length);
    answer = () => Response.json({ error: "nope" }, { status: 500 });
    await loadTools();
    expect(toolsError.value).toBe("nope");
  });

  test("a write replaces what it holds with the server's rows", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    answer = (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body as string });
      if (url.startsWith("/api/tools/")) {
        return Response.json({ tools: [{ ...time, enabled: false }], search });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ limits: [{ ...rounds, value: 3, changedAt: 9 }] });
    };
    await patchTool("get_current_time", { enabled: false });
    expect(tools.value?.tools[0]?.enabled).toBe(false);
    expect(calls[0]).toMatchObject({
      url: "/api/tools/get_current_time",
      method: "PATCH",
      body: '{"enabled":false}',
    });
    await saveLimits({ values: { rounds: 3 } as never });
    expect(limits.value?.[0]?.value).toBe(3);
    await resetLimits();
    expect(calls.map((c) => c.method)).toEqual([
      "PATCH",
      "PUT",
      "DELETE",
      "GET",
    ]);
  });

  test("the entities go with the signed-in user", () => {
    tools.value = { tools: [time], search };
    me.value = { ...admin, id: "u2" };
    expect(tools.value).toBeNull();
  });
});

describe("the page", () => {
  test("sits in the Admin group after Agents", () => {
    const group = railRows("admin").find((r) => r.kind === "group");
    const labels =
      group?.kind === "group" ? group.routes.map((r) => r.nav!.label) : [];
    expect(labels).toEqual(["Agents", "Tools"]);
    expect(railRows("member").some((r) => r.kind === "group")).toBe(false);
  });

  test("renders the rows, the switch, the providers and the fields", () => {
    tools.value = { tools: [time], search };
    limits.value = rows;
    const html = render(<Tools />);
    expect(html).toContain("get_current_time");
    expect(html).toContain('role="switch"');
    expect(html).not.toContain("md-pre");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("exa.key present");
    expect(html).toContain("firecrawl.key keyless");
    expect(html).not.toContain("tools-meta-bad");
    expect(html).toContain("websearch runs on exa.");
    expect(html).toContain("Per send");
    expect(html).toContain("Per call");
    expect(html).toContain('type="number"');
    expect(html).toContain('step="any"');
    expect(html).toContain('value="1.5"');
    expect(html).toContain("default 20 s");
    expect(html).toContain("applies to the next send");
  });

  test("says it is loading, then the failure", () => {
    expect(render(<Tools />)).toContain("Loading");
    toolsError.value = "the server did not answer";
    expect(render(<Tools />)).toContain("the server did not answer");
  });
});
