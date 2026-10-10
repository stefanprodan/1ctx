// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tools and limits model: the unit each limit is typed in and the
// conversion both ways, the range check in the page's words, the
// draft and what a Save collects, the search lines; the entity that
// loads both routes and replaces what it holds on a write; and the
// Config board rendered over the rows.

import { beforeEach, describe, expect, test } from "bun:test";
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
import {
  automationLine,
  builtinsOf,
  CONFIG_TABS,
  configTab,
  instanceLines,
  LIMITS_CARDS,
  offered,
  STORAGE_CARDS,
} from "../../../src/client/views/admin/Config.model.ts";
import { ConfigBoard } from "../../../src/client/views/admin/ConfigBoard.tsx";
import {
  atDefaults,
  collect,
  defaultLine,
  defaultsDraft,
  dirty,
  displayOf,
  draftOf,
  LIMIT_WORDS,
  limitFieldOf,
  limitRefusal,
  problem,
  read,
  seedOf,
  show,
} from "../../../src/client/views/admin/Limits.model.ts";
import { ToolRow } from "../../../src/client/views/admin/ToolRow.tsx";
import {
  jsonLines,
  totalTokens,
  WHEN_WORDS,
} from "../../../src/client/views/admin/Tools.model.ts";
import { VISUAL_LIMITS } from "../../../src/client/views/admin/Visuals.model.ts";
import {
  accessBody,
  domainsFieldOf,
  searchKeyLine,
  searchLine,
  WEB_LIMITS,
} from "../../../src/client/views/admin/WebAccess.model.ts";
import type { ToolsResponse } from "../../../src/shared/api/tools.ts";
import {
  LIMIT_NAMES,
  type LimitRow,
} from "../../../src/shared/contracts/limit.ts";
import type {
  BuiltinToolSummary,
  SearchState,
  WebToolSummary,
} from "../../../src/shared/contracts/tool.ts";
import type { WebAccess } from "../../../src/shared/web.ts";
import { deferred } from "../../helpers/async.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import {
  admin as adminFixture,
  automationTool,
  emailUser,
} from "../../helpers/client-fixtures.ts";

const admin = adminFixture();

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
const sendsPerUser = row({
  name: "sendsPerUser",
  value: 4,
  default: 4,
  min: 1,
  max: 16,
  unit: "count",
  scope: "sends",
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
const toolWorkTokens = row({
  name: "toolWorkTokens",
  default: 500_000,
  value: 750_000,
  min: 10_000,
  max: 10_000_000,
  unit: "tokens",
  changedAt: 1,
});
const maxBashCalls = row({
  name: "maxBashCalls",
  value: 200,
  max: 1000,
  scope: "call",
  changedAt: 1,
});
const rows = [
  rounds,
  toolMs,
  resultBytes,
  timeout,
  searchBody,
  cut,
  reserve,
  sendsPerUser,
  maxVisuals,
  toolWorkTokens,
  maxBashCalls,
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
  emailUser: emailUser(),
  automation: automationTool(),
});
const search: SearchState = {
  provider: "exa",
  keys: { exa: true, firecrawl: false, tavily: false },
};

let answer: (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls = clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = admin;
  tools.value = null;
  limits.value = null;
  toolsError.value = null;
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
      expect(displayOf(reserve)).toEqual({
        word: "K",
        factor: 1000,
        thousands: true,
      });
      expect(displayOf(toolWorkTokens).word).toBe("K");
      expect(show(reserve, 20_000)).toBe("20");
      expect(displayOf(maxBashCalls)).toEqual({ word: "", factor: 1 });
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
    const tokensRange =
      "Tool-work tokens must be a whole number from 10 to 10,000 K";
    expect(problem(toolWorkTokens, "9")).toBe(tokensRange);
    expect(problem(toolWorkTokens, "10001")).toBe(tokensRange);
    expect(problem(toolWorkTokens, "12.5")).toBe(tokensRange);
    expect(problem(toolWorkTokens, " ")).toBe(
      "Tool-work tokens needs a number",
    );
    expect(problem(maxBashCalls, "1001")).toBe(
      "Bash calls per turn must be from 1 to 1000",
    );
    for (const row of [toolWorkTokens, maxBashCalls]) {
      expect(problem(row, show(row, row.min))).toBeNull();
      expect(problem(row, show(row, row.max))).toBeNull();
    }
    expect(limitFieldOf("toolWorkTokens needs a number")).toBe(
      "toolWorkTokens",
    );
    expect(limitFieldOf("maxBashCalls is out of range")).toBe("maxBashCalls");
  });

  test("the send caps are held in order before a save, on the field changed", () => {
    const sends = [
      sendsPerUser,
      row({
        name: "sendsPerProject",
        value: 16,
        default: 16,
        min: 4,
        max: 64,
        scope: "sends",
      }),
      row({
        name: "sendsRunning",
        value: 64,
        default: 64,
        min: 4,
        max: 256,
        scope: "sends",
      }),
    ];
    const draft = draftOf(sends);
    expect(collect(sends, { ...draft, sendsPerUser: "16" })).toMatchObject({
      values: { sendsPerUser: 16 },
    });
    expect(
      collect(sends, { ...draft, sendsPerUser: "12", sendsPerProject: "8" }),
    ).toEqual({
      problem: "Per user must not be above Per project",
      field: "sendsPerUser",
    });
    expect(collect(sends, { ...draft, sendsPerProject: "3" })).toEqual({
      problem: "Per project must be from 4 to 64",
      field: "sendsPerProject",
    });
    expect(
      collect(sends, { ...draft, sendsPerProject: "4", sendsPerUser: "4" }),
    ).toMatchObject({
      values: { sendsPerProject: 4 },
    });
    expect(collect(sends, { ...draft, sendsRunning: "8" })).toEqual({
      problem: "Per project must not be above At once",
      field: "sendsRunning",
    });
    expect(
      collect(sends, { ...draft, sendsPerProject: "32", sendsRunning: "16" }),
    ).toEqual({
      problem: "Per project must not be above At once",
      field: "sendsPerProject",
    });
  });

  test("a server refusal names each limit by its label and keeps the field", () => {
    expect(
      limitRefusal("sendsPerUser must not be above sendsPerProject"),
    ).toEqual({
      words: "Per user must not be above Per project",
      field: "sendsPerUser",
    });
    expect(limitRefusal("rounds must be between 1 and 500")).toEqual({
      words: "Rounds must be between 1 and 500",
      field: "rounds",
    });
    expect(limitRefusal("values must name a limit")).toEqual({
      words: "values must name a limit",
      field: undefined,
    });
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
        sendsPerUser: 4,
        maxVisuals: 2,
        toolWorkTokens: 750_000,
        maxBashCalls: 200,
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
    expect(defaultLine(toolWorkTokens)).toBe("default 500 K");
    expect(defaultLine(maxBashCalls)).toBe("default 100");
  });

  test("tokens are typed in thousands, a stored value kept when untouched", () => {
    const summary = row({
      name: "summaryMaxTokens",
      value: 8192,
      default: 4096,
      min: 1000,
      max: 32_000,
      unit: "tokens",
      scope: "send",
      changedAt: 1,
    });
    expect(show(summary, 8192)).toBe("8");
    expect(show(summary, 1500)).toBe("2");
    expect(read(summary, "8")).toBe(8192);
    expect(read(summary, "16")).toBe(16_000);
    expect(read(summary, "1,000")).toBe(1_000_000);
    expect(read(summary, "1.5")).toBeNull();
    expect(read(summary, "")).toBeNull();
    // typed by hand, only the stored value's text keeps it
    expect(read(summary, "4")).toBe(4000);
    expect(problem(summary, "33")).toBe(
      "Summary tokens must be a whole number from 1 to 32 K",
    );
    expect(problem(summary, "8")).toBeNull();
    // a save of another field sends the stored value unchanged
    const draft = draftOf([summary, rounds]);
    expect(draft.summaryMaxTokens).toBe("8");
    expect(dirty([summary, rounds], draft)).toBe(false);
    expect(
      collect([summary, rounds], { ...draft, rounds: "12" }) as unknown,
    ).toEqual({ values: { summaryMaxTokens: 8192, rounds: 12 } });
    const reset = defaultsDraft([summary]);
    expect(reset.draft.summaryMaxTokens).toBe("4");
    expect(atDefaults([summary], reset.draft, reset.defaulted)).toBe(true);
    expect(collect([summary], reset.draft, reset.defaulted) as unknown).toEqual(
      { values: { summaryMaxTokens: 4096 } },
    );
    expect(dirty([summary], { summaryMaxTokens: "9" })).toBe(true);
    expect(collect([summary], { summaryMaxTokens: "9" }) as unknown).toEqual({
      values: { summaryMaxTokens: 9000 },
    });
  });

  test("a stored value that shows as its default can be put back to it", () => {
    const summary = row({
      name: "summaryMaxTokens",
      value: 4400,
      default: 4096,
      min: 1000,
      max: 32_000,
      unit: "tokens",
      scope: "send",
      changedAt: 1,
    });
    const draft = draftOf([summary]);
    expect(draft.summaryMaxTokens).toBe("4");
    // Use defaults stays on: the value differs though the text does not
    expect(atDefaults([summary], draft)).toBe(false);
    expect(dirty([summary], draft)).toBe(false);
    // untouched, the stored value goes back
    expect(collect([summary], draft) as unknown).toEqual({
      values: { summaryMaxTokens: 4400 },
    });
    // Use defaults, then Save, sends the default
    const reset = defaultsDraft([summary]);
    expect(reset.draft).toEqual(draft);
    expect(atDefaults([summary], reset.draft, reset.defaulted)).toBe(true);
    expect(dirty([summary], reset.draft, reset.defaulted)).toBe(true);
    expect(collect([summary], reset.draft, reset.defaulted) as unknown).toEqual(
      { values: { summaryMaxTokens: 4096 } },
    );
    // typed by hand, the stored value's text keeps the stored value
    expect(collect([summary], { summaryMaxTokens: "4" }) as unknown).toEqual({
      values: { summaryMaxTokens: 4400 },
    });
    expect(collect([summary], { summaryMaxTokens: "5" }) as unknown).toEqual({
      values: { summaryMaxTokens: 5000 },
    });
  });

  test.serial("a card sums its tokens and re-seeds only on new values", () => {
    expect(totalTokens([{ tokens: 96 }, { tokens: 2716 }])).toBe(2812);
    // another form's save moves only the change times: no re-seed
    expect(seedOf([{ ...timeout, changedAt: 99 }])).toBe(seedOf([timeout]));
    expect(seedOf([{ ...timeout, value: 2000 }])).not.toBe(seedOf([timeout]));
  });

  test.serial("the search lines and the first sentence", () => {
    expect(searchKeyLine("exa", true)).toBe("search-exa.key present");
    expect(searchKeyLine("firecrawl", false)).toBe(
      "search-firecrawl.key keyless",
    );
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
  test.serial("gives the sorted hosts a save sends", () => {
    expect(accessBody("listed", "GitHub.com\n\n docs.example.com \n")).toEqual({
      body: { mode: "listed", domains: ["docs.example.com", "github.com"] },
    });
  });

  test.serial(
    "an empty box and a line that is not a host are the field's words",
    () => {
      expect(accessBody("listed", " \n")).toEqual({
        error: "List at least one host.",
      });
      expect(accessBody("listed", "github.com\n*.github.com")).toEqual({
        error: "Line 2, *.github.com, is not a host name.",
      });
      expect(accessBody("listed", "https://github.com")).toEqual({
        error: "Line 1, https://github.com, is not a host name.",
      });
    },
  );

  test.serial("a refusal about hosts belongs to the box", () => {
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
      answer = (url) => {
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
        init: { method: "PATCH", body: '{"enabled":false}' },
      });
      await saveLimits({ values: { rounds: 3 } as never });
      expect(limits.value?.[0]?.value).toBe(3);
      expect(calls.map((c) => c.init?.method)).toEqual(["PATCH", "PUT"]);
    },
  );

  test.serial(
    "an earlier write answering last does not undo a later one",
    async () => {
      const pending: ReturnType<typeof deferred<void>>[] = [];
      answer = (_url, init) => {
        const enabled = JSON.parse(init?.body as string).enabled as boolean;
        const held = deferred<void>();
        pending.push(held);
        return held.promise.then(() =>
          Response.json(body({ ...fetchTool, enabled })),
        );
      };
      const first = patchTool("visualize", { enabled: false });
      const second = patchTool("visualize", { enabled: true });
      while (pending.length < 2) await Promise.resolve();
      pending[1]!.resolve();
      await second;
      expect(tools.value?.visualize.enabled).toBe(true);
      pending[0]!.resolve();
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

describe("the Config board", () => {
  test.serial("the tab is the address", () => {
    expect(configTab("/admin/config")).toBe("overview");
    expect(configTab("/admin/config/limits")).toBe("limits");
    expect(configTab("/admin/config/storage")).toBe("storage");
    expect(CONFIG_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Limits",
      "Storage",
    ]);
    expect(onPage("/admin/config/limits", "/admin/config")).toBe(true);
    expect(WHEN_WORDS.always).not.toBe("");
  });

  test.serial("every limit is on one card of one page", () => {
    const placed = [
      ...LIMITS_CARDS.flatMap((c) => c.names),
      ...STORAGE_CARDS.flatMap((c) => c.names),
      ...WEB_LIMITS,
      ...VISUAL_LIMITS,
    ];
    expect([...placed].sort()).toEqual([...LIMIT_NAMES].sort());
    expect(LIMITS_CARDS.map((c) => c.title)).toEqual([
      "Turns",
      "Running",
      "Automations",
    ]);
    expect(STORAGE_CARDS.map((c) => c.title)).toEqual([
      "Knowledge",
      "Scratch",
      "Chats",
      "MCP results",
      "Repositories",
    ]);
  });

  test.serial("a tool is off while no turn is offered it", () => {
    const state = body();
    // automation has its own card with its switch
    expect(builtinsOf(state).map((t) => t.name)).toEqual([
      "datetime",
      "visualize",
    ]);
    expect(offered(time, state)).toBe(true);
    const webfetch = { ...time, name: "webfetch" as const };
    const websearch = { ...time, name: "websearch" as const };
    expect(offered(webfetch, state)).toBe(true);
    expect(offered(websearch, state)).toBe(true);
    const off = body(fetchTool, { ...access, mode: "off" });
    expect(offered(webfetch, off)).toBe(false);
    expect(offered(websearch, off)).toBe(false);
    expect(
      offered(websearch, { ...state, search: { ...search, provider: null } }),
    ).toBe(false);
    const hidden = body({ ...fetchTool, enabled: false });
    expect(offered(hidden.visualize, hidden)).toBe(false);
    // email_user takes the admin's switch and a server set up
    const email = (over: Partial<ToolsResponse["emailUser"]>) => ({
      ...state,
      emailUser: emailUser(over),
      automation: automationTool(),
    });
    const on = email({ enabled: true, emailOn: true });
    expect(offered(on.emailUser, on)).toBe(true);
    expect(builtinsOf(on).map((t) => t.name)).toEqual([
      "datetime",
      "email_user",
      "visualize",
    ]);
    const noServer = email({ enabled: true, emailOn: false });
    expect(offered(noServer.emailUser, noServer)).toBe(false);
    const switched = email({ enabled: false, emailOn: true });
    expect(offered(switched.emailUser, switched)).toBe(false);
  });

  test.serial(
    "an open row names the description and counts the schema's lines",
    () => {
      const html = render(<ToolRow tool={time} open onToggle={() => {}} />);
      expect(html).toContain('<div class="label">Description</div>');
      expect(html).not.toContain("Description for agents");
      // a short schema is not cut: no fade, no Show all
      expect(html).toContain('class="fold fold-inset fold-framed"');
      expect(html).not.toContain("fold-more");
      expect(jsonLines({ type: "object", properties: {} })).toBe(4);
      expect(jsonLines({})).toBe(1);
    },
  );

  test.serial("memory_edit says when each of its two texts is sent", () => {
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

  test.serial("the aside counts what is loaded and says what turns get", () => {
    const lines = instanceLines(body(), {
      providers: [1, 2],
      agents: [1],
      deciders: [],
      servers: null,
      skills: [1, 2, 3],
      credentials: [1],
    });
    expect(lines.map((l) => [l.label, l.value, l.quiet])).toEqual([
      ["Providers", "2", false],
      ["Agents", "1", false],
      ["Deciders", "0", true],
      ["Skills", "3", false],
      ["Visuals", "On", false],
      ["Web access", "All domains", false],
      ["Search", "exa", false],
      ["Credentials", "1", false],
    ]);
    expect(lines.find((l) => l.label === "Credentials")?.href).toBe(
      "/admin/config/web/credentials",
    );
    const off = instanceLines(
      {
        ...body({ ...fetchTool, enabled: false }, { ...access, mode: "off" }),
        search: { ...search, provider: null },
      },
      {
        providers: null,
        agents: null,
        deciders: null,
        servers: null,
        skills: null,
        credentials: null,
      },
    );
    expect(off.map((l) => [l.label, l.value, l.quiet])).toEqual([
      ["Visuals", "Off", true],
      ["Web access", "Off", true],
      ["Search", "None", true],
    ]);
  });

  test.serial("Overview lists every built-in with its tokens", () => {
    tools.value = body({ ...fetchTool, enabled: false });
    limits.value = rows;
    path.value = "/admin/config";
    const html = render(<ConfigBoard />);
    expect(html).toContain('class="tabs"');
    expect(html).toContain("datetime");
    expect(html).toContain("The current date and time in a timezone.");
    expect(html).toMatch(/rows-hint[^>]*>2.81K tokens/);
    expect(html).toContain(
      '<span class="rows-name rows-name-mono"><span class="cut">datetime',
    );
    // visualize is switched off: Off in place of its tokens
    expect(html).toContain("rows-item rows-item-off");
    // the automation tool's card is the one switch, its Save in a form
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    const card = forms.find((form) =>
      form.includes("Agents manage scheduled tasks"),
    )!;
    expect(card).toContain('role="switch"');
    expect(card).toContain('aria-checked="true"');
    expect(card).toContain('type="submit"');
    expect(card).toContain(automationLine(true));
    expect(card).toContain('<span class="cut">automation</span>');
    expect(html).not.toContain("md-pre");
    // the cards of the other tabs are drawn, hidden
    expect(html.match(/config-board-away/g)).toHaveLength(2);
    expect(html).toContain(">Instance<");
    expect(html).toContain('href="/admin/config/visuals"');
    path.value = "/";
  });

  test("the automation card's line says what its switch does", () => {
    expect(automationLine(true)).toBe(
      "A chat's agent may read its project's scheduled tasks and propose changes a user confirms. Each chat can turn it off.",
    );
    expect(automationLine(false)).toBe(
      "No agent reads or changes scheduled tasks.",
    );
  });

  test.serial("the automation switch draws the row off", async () => {
    tools.value = body();
    tools.value = {
      ...tools.value,
      automation: automationTool({ enabled: false }),
    };
    limits.value = rows;
    path.value = "/admin/config";
    const html = render(<ConfigBoard />);
    const card = (html.match(/<form\b[\s\S]*?<\/form>/g) ?? []).find((form) =>
      form.includes("Agents manage scheduled tasks"),
    )!;
    expect(card).toContain('aria-checked="false"');
    expect(card).toContain(automationLine(false));
    path.value = "/";
  });

  test.serial("Limits and Storage draw their cards", () => {
    tools.value = body();
    limits.value = rows;
    path.value = "/admin/config/limits";
    const html = render(<ConfigBoard />);
    expect(html).toContain(">Turns<");
    expect(html).toContain(">Automations<");
    expect(html).toContain(">Knowledge<");
    // the automation card stays mounted, hidden, so its draft is kept
    expect(html.match(/<form/g)).toHaveLength(9);
    expect(html).toMatch(
      /config-board-cards config-board-away"><form[\s\S]*?Agents manage scheduled tasks/,
    );
    expect(html).toContain(">Running<");
    expect(html).toContain("Per user");
    expect(html).toContain("Scheduled runs are not counted.");
    expect(html).toContain("Call timeout");
    expect(html).toContain('value="1.5"');
    expect(html).toContain("default 20 s");
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    const turns = forms[0]!;
    expect(turns).toContain(">Turns<");
    for (const [name, value, label, defaultText] of [
      ["toolWorkTokens", "750", "Tool-work tokens", "default 500 K"],
      ["maxBashCalls", "200", "Bash calls per turn", "default 100"],
    ]) {
      expect(turns).toContain(label);
      expect(turns).toMatch(new RegExp(`name="${name}"[^>]*value="${value}"`));
      expect(turns).toContain(defaultText);
      for (const form of forms.filter((form) => form !== turns)) {
        expect(form).not.toContain(`name="${name}"`);
      }
    }
    // the web and visual limits are on their own pages
    expect(html).not.toContain('name="searchBodyBytes"');
    expect(html).not.toContain('name="maxVisuals"');
    expect(html).not.toContain("Disk use");
    path.value = "/admin/config/storage";
    expect(render(<ConfigBoard />)).toContain('href="/admin/monitor/storage"');
    path.value = "/";
  });

  test.serial("says it is loading, then the failure", () => {
    expect(render(<ConfigBoard />)).toContain("Loading");
    toolsError.value = {
      words: "the server failed while answering",
      status: 500,
    };
    const html = render(<ConfigBoard />);
    expect(html).toContain("The server failed while answering.");
    expect(html).toContain('<span class="code-tag">HTTP 500</span>');
  });
});
