// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { h } from "preact";
import { render } from "preact-render-to-string";
import { zoneLit } from "../../../src/client/app/Rail.model.ts";
import { overview } from "../../../src/client/data/overview.ts";
import { lengthWord, money } from "../../../src/client/lib/format.ts";
import {
  attentionRow,
  automationsTile,
  buildLine,
  costOf,
  costTile,
  cpuTile,
  dayTokensHint,
  decisionsTile,
  memoryTile,
  runningTile,
  runsTile,
  staleWords,
  tokensTile,
  turnsTile,
  zoomed,
} from "../../../src/client/views/admin/Overview.model.ts";
import { Overview } from "../../../src/client/views/admin/Overview.tsx";
import {
  activeTile,
  activityHint,
  activitySeries,
  failureSeries,
  failureTile,
  lengthAxis,
  lengthHint,
  lengthSeries,
} from "../../../src/client/views/admin/Stats.model.ts";
import {
  agentBars,
  modelBars,
  modelLabel,
  monthLabel,
  monthSteps,
  usageBars,
} from "../../../src/client/views/admin/Usage.model.ts";
import type {
  LoadResponse,
  OverviewDay,
  OverviewResponse,
  OverviewTotals,
  UsageRow,
} from "../../../src/shared/api/admin.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const totals = (over: Partial<OverviewTotals> = {}): OverviewTotals => ({
  turns: 100,
  turnsFailed: 4,
  runs: 20,
  runsFailed: 0,
  promptTokens: 1000,
  cachedTokens: 380,
  completionTokens: 200,
  rounds: 30,
  pricedRounds: 12,
  cost: 4.123,
  decisions: 0,
  decisionTokens: 0,
  pricedDecisions: 0,
  decisionCost: null,
  ...over,
});

const day = (over: Partial<OverviewDay> = {}): OverviewDay => ({
  day: "2026-09-13",
  start: new Date(2026, 8, 13).getTime(),
  turns: 31,
  turnsFailed: 1,
  runs: 1,
  runsFailed: 0,
  promptTokens: 1000,
  cachedTokens: 420,
  completionTokens: 100,
  cost: 0.031,
  decisions: 0,
  decisionTokens: 0,
  pricedDecisions: 0,
  decisionCost: null,
  medianMs: 20_000,
  p95Ms: 65_000,
  activeUsers: 3,
  ...over,
});

const load = (over: Partial<LoadResponse> = {}): LoadResponse => ({
  at: 0,
  chats: 3,
  runs: 1,
  cap: 64,
  scheduled: 1,
  scheduledCap: 48,
  projectsFull: 0,
  online: 5,
  automations: 12,
  waiting: 0,
  cores: 12,
  memoryLimit: 96 * GB,
  contained: false,
  samples: { at: [0, 5000], cpu: [0.02, 0.034], rss: [190 * MB, 198 * MB] },
  ...over,
});

const row = (over: Partial<UsageRow>): UsageRow => ({
  cost: null,
  deleted: false,
  id: "a1",
  name: "platform",
  owner: null,
  tokens: 600,
  turns: 3,
  runs: 0,
  ...over,
});

describe("the Now tiles", () => {
  test("chats and runs against the process's slots, full at the cap", () => {
    expect(runningTile(load())).toEqual({
      figure: "4",
      unit: "/ 64 slots",
      sub: "3 chats · 1 run · 5 users online",
      share: 4 / 64,
      full: false,
    });
    expect(runningTile(load({ chats: 60, runs: 4, online: 1 }))).toMatchObject({
      sub: "60 chats · 4 runs · 1 user online",
      full: true,
    });
  });

  test("scheduled runs against their share, with waits and full projects", () => {
    expect(automationsTile(load())).toEqual({
      figure: "1",
      unit: "/ 48 slots",
      sub: "12 automations",
      share: 1 / 48,
      full: false,
    });
    expect(automationsTile(load({ waiting: 4 })).sub).toBe(
      "12 automations · 4 waiting",
    );
    expect(
      automationsTile(load({ scheduled: 48, waiting: 4, projectsFull: 2 })),
    ).toMatchObject({
      sub: "12 automations · 4 waiting · 2 projects full",
      full: true,
    });
  });

  test("CPU and memory from the newest sample", () => {
    expect(cpuTile(load())).toEqual({ figure: "3%", sub: "of 12 cores" });
    expect(cpuTile(load({ cores: 1 })).sub).toBe("of 1 core");
    expect(memoryTile(load())).toMatchObject({
      figure: "198",
      unit: "MB",
      sub: "of 96 GB",
      full: false,
    });
    const boxed = memoryTile(
      load({
        contained: true,
        memoryLimit: 512 * MB,
        samples: { at: [0], cpu: [0], rss: [412 * MB] },
      }),
    );
    expect(boxed).toMatchObject({ sub: "of 512 MB limit", full: true });
    expect(boxed.share).toBeCloseTo(412 / 512);
  });

  test("a failed read says since when, or that nothing loaded", () => {
    expect(staleWords(new Date(2026, 8, 24, 11, 33).getTime())).toBe(
      "Not updated since 11:33",
    );
    expect(staleWords(null)).toBe("Did not load");
  });

  test("the memory scale leaves room around the window", () => {
    expect(zoomed(100, 200)).toEqual([70, 230]);
    expect(zoomed(100, 100)).toEqual([98, 102]);
    expect(zoomed(0, 0)).toEqual([0, 0]);
  });
});

describe("the last 30 days", () => {
  test("turns and runs say the failed share, or a day's", () => {
    expect(turnsTile(totals(), null)).toEqual({
      figure: "100",
      unit: "turns",
      sub: "4% failed",
    });
    expect(turnsTile(totals({ turns: 1, turnsFailed: 0 }), null)).toEqual({
      figure: "1",
      unit: "turn",
      sub: "none failed",
    });
    expect(turnsTile(totals({ turns: 0 }), null).sub).toBe("none yet");
    expect(turnsTile(totals(), day()).sub).toBe("13 Sep · 31 turns · 1 failed");
    expect(runsTile(totals(), day()).sub).toBe("13 Sep · 1 run");
  });

  test("tokens say the cached share of the input", () => {
    expect(tokensTile(totals(), null)).toEqual({
      figure: "1.2K",
      sub: "38% cached",
    });
    expect(tokensTile(totals(), day()).sub).toBe("13 Sep · 1.1K");
    expect(tokensTile(totals({ promptTokens: 0 }), null).sub).toBe("none yet");
    expect(dayTokensHint(day())).toBe("13 Sep · 1.1K tokens · 42% cached");
  });

  test("cost is never $0 when no round was priced", () => {
    expect(costTile(totals(), null)).toEqual({
      figure: "$4.12",
      sub: "12 of 30 priced",
    });
    expect(costTile(totals(), day()).sub).toBe("13 Sep · $0.03");
    expect(costTile(totals({ cost: null }), day())).toEqual({
      figure: "None",
      sub: "no provider priced",
    });
    expect(costTile(totals({ cost: null, rounds: 0 }), null).sub).toBe(
      "none yet",
    );
    expect(money(0.004)).toBe("<$0.01");
  });

  test("the rounds' cost and the decisions' add, a null counting as 0", () => {
    expect(costOf({ cost: null, decisionCost: null })).toBeNull();
    expect(costOf({ cost: 1.5, decisionCost: null })).toBe(1.5);
    expect(costOf({ cost: null, decisionCost: 0.25 })).toBe(0.25);
    expect(costOf({ cost: 1.5, decisionCost: 0.25 })).toBe(1.75);
    const both = totals({
      decisions: 10,
      pricedDecisions: 8,
      decisionCost: 0.877,
    });
    expect(costTile(both, null)).toEqual({
      figure: "$5.00",
      sub: "20 of 40 priced",
    });
    expect(costTile(both, day({ cost: null, decisionCost: 0.02 })).sub).toBe(
      "13 Sep · $0.02",
    );
    // decisions alone, priced, are a cost; a local decider's are not
    expect(
      costTile(
        totals({
          rounds: 0,
          pricedRounds: 0,
          cost: null,
          decisions: 4,
          pricedDecisions: 4,
          decisionCost: 0.02,
        }),
        null,
      ),
    ).toEqual({ figure: "$0.02", sub: "4 of 4 priced" });
    expect(
      costTile(
        totals({ rounds: 0, pricedRounds: 0, cost: null, decisions: 4 }),
        null,
      ),
    ).toEqual({ figure: "None", sub: "no provider priced" });
  });

  test("on Usage decisions close the automations sub-line, on a day too", () => {
    const t = totals({ runs: 10, decisions: 1234 });
    expect(runsTile(t, null).sub).toBe("none failed · 1,234 decisions");
    expect(runsTile(t, day({ decisions: 1 })).sub).toBe(
      "13 Sep · 1 run · 1 decision",
    );
    expect(runsTile(totals({ runs: 10 }), null).sub).toBe("none failed");
  });

  test("the decisions tile counts them and the tokens they read", () => {
    const t = totals({ decisions: 1234, decisionTokens: 56_000 });
    expect(decisionsTile(t, null)).toEqual({
      figure: "1,234",
      unit: "decisions",
      sub: "56K tokens",
    });
    expect(decisionsTile(t, day({ decisions: 1 })).sub).toBe(
      "13 Sep · 1 decision",
    );
    expect(decisionsTile(totals(), null)).toEqual({
      figure: "0",
      unit: "decisions",
      sub: "none yet",
    });
  });

  test.serial(
    "the Monitor's Stats show decisions on their own and no money",
    () => {
      const answer = (last: number): OverviewResponse => ({
        readAt: 0,
        range: "30d",
        days: [day()],
        totals: totals({ decisions: last, decisionTokens: last * 10 }),
        turnLength: { medianMs: 20_000, p95Ms: 65_000 },
        activeUsers: 4,
        instance: {
          version: "test",
          startedAt: 0,
          users: 1,
          projects: 1,
          agents: 1,
          automations: 0,
          databaseBytes: MB,
        },
      });
      const page = (a: OverviewResponse) => {
        overview.value = a;
        try {
          return render(h(Overview, {}));
        } finally {
          overview.value = null;
        }
      };
      const html = page(answer(3));
      expect(html).toContain(">Stats<");
      expect(html).toContain(">Decisions<");
      expect(html).toContain("30 tokens");
      expect(html).not.toContain("· 3 decisions");
      // the range switch, and no All time or link to Usage
      for (const word of [">30d<", ">90d<", ">All<"]) {
        expect(html).toContain(word);
      }
      expect(html).not.toContain("All time");
      expect(html).toContain(">Active users<");
      expect(html).toContain(">Failure rate<");
      expect(html).toContain("4 failures");
      expect(html).not.toContain(">Chats<");
      expect(html).toContain(">Activity<");
      expect(html).toContain(">LLM response time<");
      expect(html).toContain("median 20s · p95 1m 5s");
      expect(html).not.toContain('href="/admin/monitor/usage"');
      expect(html).not.toContain("$");
      expect(html).not.toContain(">Cost<");
    },
  );
});

describe("the breakdowns", () => {
  test("a personal project is its owner, a team project its name", () => {
    const bars = usageBars("projects", [
      row({}),
      row({ id: null, name: null, owner: "alice", tokens: 400, turns: 2 }),
    ]);
    expect(bars.map((b) => [b.name, b.hint, b.mono])).toEqual([
      ["#platform", "60% · 3 turns", false],
      ["@alice", "40% · 2 turns", false],
    ]);
  });

  test("an agent in mono, its runs beside its turns", () => {
    const [agent, runner] = usageBars("agents", [
      row({ name: "sre", runs: 2 }),
      row({ id: "a2", name: "digest", turns: 0, runs: 5 }),
    ]);
    expect(agent).toMatchObject({ name: "sre", mono: true, label: "600" });
    expect(agent?.hint).toBe("50% · 3 turns · 2 runs");
    expect(runner?.hint).toBe("50% · 5 runs");
  });

  test("the deleted projects are one named row, a retired agent is marked deleted", () => {
    const projects = usageBars("projects", [
      row({}),
      row({ id: null, name: null, deleted: true, tokens: 100 }),
    ]);
    expect(projects.map((b) => [b.name, b.note, b.key])).toEqual([
      ["#platform", undefined, "a1"],
      ["deleted projects", undefined, "deleted"],
    ]);
    // a retired sre and a live one of its name are two bars
    const agents = usageBars("agents", [
      row({ id: "a1", name: "sre", deleted: true }),
      row({ id: "a2", name: "sre" }),
    ]);
    expect(agents.map((b) => [b.name, b.note, b.key])).toEqual([
      ["sre", "deleted", "a1"],
      ["sre", undefined, "a2"],
    ]);
  });

  test("a priced row's cost follows its tokens, an unpriced one's a dash", () => {
    const [priced, free] = usageBars("projects", [
      row({ cost: 0.5 }),
      row({ cost: null }),
    ]);
    expect(priced?.cost).toBe("$0.50");
    expect(priced?.hint).toBe("50% · 3 turns");
    expect(free?.cost).toBe("-");
    const [alone] = usageBars("projects", [row({ cost: null })]);
    expect(alone?.cost).toBeUndefined();
  });

  test("a model by its tokens, its provider first in the hint", () => {
    const bars = modelBars([
      {
        provider: "router",
        model: "vendor/big-1",
        tokens: 300,
        cost: 0.004,
        rounds: 3,
      },
      { provider: null, model: "small-2", tokens: 100, cost: null, rounds: 1 },
    ]);
    expect(bars.map((b) => [b.name, b.label, b.cost, b.hint, b.mono])).toEqual([
      ["big-1", "300", "<$0.01", "router · 75%", true],
      ["small-2", "100", "-", "deleted provider · 25%", true],
    ]);
  });

  test("a cost above ten cents is marked, ten cents or less is not", () => {
    const bars = usageBars("projects", [
      row({ id: "a", cost: 0.11 }),
      row({ id: "b", cost: 0.1 }),
      row({ id: "c", cost: null }),
    ]);
    expect(bars.map((b) => [b.cost, b.costly])).toEqual([
      ["$0.11", true],
      ["$0.10", false],
      ["-", false],
    ]);
  });

  test("the agents and the deciders by tokens, the share over both", () => {
    const bars = agentBars(
      [row({ id: "a1", name: "coder", tokens: 600, cost: 0.5 })],
      [{ name: "jev", decisions: 12, tokens: 1_400, cost: null }],
    );
    expect(bars.map((b) => [b.name, b.note, b.label, b.cost, b.hint])).toEqual([
      ["jev", "decider", "1.4K", "-", "70% · 12 decisions"],
      ["coder", undefined, "600", "$0.50", "30% · 3 turns"],
    ]);
  });

  test("the arrows step a month between the first turn's and this one", () => {
    // across a year
    expect(monthSteps("2026-01", "2025-06", "2026-09").back).toBe("2025-12");
    expect(monthSteps("2025-12", "2025-06", "2026-09").forward).toBe("2026-01");
    expect(monthSteps("2026-09", "2026-06", "2026-09")).toEqual({
      back: "2026-08",
      forward: null,
    });
    expect(monthSteps("2026-06", "2026-06", "2026-09")).toEqual({
      back: null,
      forward: "2026-07",
    });
    expect(monthSteps("2026-09", null, "2026-09")).toEqual({
      back: null,
      forward: null,
    });
    // a month before the first, reached by its address, only goes forward
    expect(monthSteps("2026-03", "2026-06", "2026-09")).toEqual({
      back: null,
      forward: "2026-04",
    });
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2025-12")).toBe("December 2025");
    expect(monthLabel("2026-09", true)).toBe("Sep 2026");
  });

  test("a model loses its org unless a bare word is left", () => {
    expect(modelLabel("mlx-community/LFM2.5-8B")).toBe("LFM2.5-8B");
    expect(modelLabel("openrouter/free")).toBe("openrouter/free");
    expect(modelLabel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
  });

  test("a turn's length in words", () => {
    expect(lengthWord(41_000)).toBe("41s");
    expect(lengthWord(200_000)).toBe("3m 20s");
    expect(lengthWord(120_000)).toBe("2m");
    expect(lengthWord(3_900_000)).toBe("1h 5m");
  });
});

describe("needs attention", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");

  test("a row names the thing, what failed and the page that fixes it", () => {
    expect(
      attentionRow({ kind: "provider-key", name: "router", at: null }, now),
    ).toMatchObject({
      name: "router",
      line: "key file missing",
      what: "Provider",
      icon: "key",
      href: "/admin/config/providers/router",
    });
    expect(
      attentionRow(
        { kind: "mcp-refresh", name: "flux", at: now - 3 * 3_600_000 },
        now,
      ),
    ).toMatchObject({
      line: "refresh failed 3h ago",
      what: "MCP Server",
      icon: "mcp",
      href: "/admin/config/mcp/flux",
    });
    expect(
      attentionRow({ kind: "credential-unusable", name: "gh", at: null }, now),
    ).toMatchObject({
      line: "key file unusable",
      href: "/admin/config/web/credentials/gh",
    });
    expect(
      attentionRow({ kind: "credential-key", name: "gh", at: null }, now).href,
    ).toBe("/admin/config/web/credentials/gh");
  });
});

describe("the Stats charts", () => {
  test("activity stacks what did not fail under every failure", () => {
    const d = day({ turns: 31, turnsFailed: 1, runs: 3, runsFailed: 2 });
    expect(activitySeries([d]).map((s) => [s.label, s.values[0]])).toEqual([
      ["Chat turns", 30],
      ["Automation runs", 1],
      ["Failed", 3],
    ]);
    expect(activityHint(totals(), d)).toBe(
      "13 Sep · 31 turns · 3 runs · 3 failed",
    );
    expect(activityHint(totals(), day({ turnsFailed: 0 }))).toBe(
      "13 Sep · 31 turns · 1 run",
    );
    expect(activityHint(totals(), null)).toBe("120 · 3% failed");
    expect(
      activityHint(totals({ turns: 0, turnsFailed: 0, runs: 0 }), null),
    ).toBe("");
  });

  test("turn length names the median and the p95", () => {
    const range = { medianMs: 19_000, p95Ms: 125_000 };
    expect(lengthHint(range, null)).toBe("median 19s · p95 2m 5s");
    expect(lengthHint(range, day())).toBe("13 Sep · median 20s · p95 1m 5s");
    expect(lengthHint(range, day({ medianMs: null, p95Ms: null }))).toBe(
      "13 Sep · no turns",
    );
    expect(lengthHint({ medianMs: null, p95Ms: null }, null)).toBe("");
    expect(lengthSeries([day(), day({ medianMs: null, p95Ms: null })])).toEqual(
      [
        { label: "Median", values: [20_000, null] },
        { label: "p95", values: [65_000, null] },
      ],
    );
    expect(lengthAxis(0)).toBe("0");
    expect(lengthAxis(120_000)).toBe("2m");
  });
});

describe("the Stats tiles", () => {
  test("active users against every user, a day's on the cursor", () => {
    expect(activeTile(6, 8, null)).toEqual({
      figure: "6",
      unit: "users",
      sub: "of 8",
    });
    expect(activeTile(1, 8, null).unit).toBe("user");
    expect(activeTile(6, 8, day({ activeUsers: 1 })).sub).toBe(
      "13 Sep · 1 user",
    );
  });

  test("the failure rate counts the failures", () => {
    const t = totals({ turns: 90, turnsFailed: 4, runs: 10, runsFailed: 1 });
    expect(failureTile(t, null)).toEqual({ figure: "5%", sub: "5 failures" });
    expect(
      failureTile(totals({ turnsFailed: 1, runsFailed: 0 }), null).sub,
    ).toBe("1 failure");
    expect(failureTile(t, day({ turnsFailed: 2 })).sub).toBe(
      "13 Sep · 2 of 32 failed",
    );
    expect(failureTile(t, day({ turnsFailed: 0 })).sub).toBe(
      "13 Sep · none failed",
    );
    expect(
      failureTile(totals({ turnsFailed: 0, runsFailed: 0 }), null),
    ).toEqual({ figure: "0%", sub: "none failed" });
    expect(
      failureTile(
        totals({ turns: 0, turnsFailed: 0, runs: 0, runsFailed: 0 }),
        null,
      ).sub,
    ).toBe("none yet");
    expect(
      failureSeries([
        day({ turnsFailed: 1, runs: 1 }),
        day({ turns: 0, runs: 0 }),
      ]),
    ).toEqual([1 / 32, 0]);
  });
});

describe("the build line", () => {
  test("names the build and how long it has been up", () => {
    const instance: OverviewResponse["instance"] = {
      version: "v1.2.3",
      startedAt: 0,
      users: 8,
      projects: 5,
      agents: 9,
      automations: 1,
      databaseBytes: 0,
    };
    expect(buildLine(instance, 7 * 3_600_000)).toBe("v1.2.3 · up 7h");
  });
});

describe("the rail", () => {
  test("lights Storage alone under /monitor/storage", () => {
    expect(zoneLit("/admin/monitor/storage")).toBe("/admin/monitor/storage");
    expect(zoneLit("/admin/monitor")).toBe("/admin/monitor");
    expect(zoneLit("/admin/config/web/credentials")).toBe("/admin/config/web");
    expect(zoneLit("/projects")).toBeNull();
  });
});
