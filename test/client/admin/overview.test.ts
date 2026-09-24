// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { litPage } from "../../../src/client/app/Rail.model.ts";
import {
  allCells,
  automationsTile,
  buildLine,
  cachedLine,
  chatTile,
  costTile,
  cpuTile,
  dayTokensHint,
  instanceParts,
  lengthBars,
  lengthWord,
  memoryTile,
  money,
  runsTile,
  shortModel,
  sinceWords,
  staleWords,
  tokensTile,
  turnsTile,
  usageBars,
  zoomed,
} from "../../../src/client/views/admin/Overview.model.ts";
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
  ...over,
});

const load = (over: Partial<LoadResponse> = {}): LoadResponse => ({
  at: 0,
  chats: 3,
  chatsCap: 32,
  runs: 1,
  runsCap: 32,
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
  id: "a1",
  name: "platform",
  owner: null,
  tokens: 600,
  turns: 3,
  runs: 0,
  ...over,
});

describe("the Now tiles", () => {
  test("the pools against their slots, full at the cap", () => {
    expect(chatTile(load())).toEqual({
      figure: "3",
      unit: "/ 32 slots",
      sub: "5 users online",
      share: 3 / 32,
      full: false,
    });
    expect(chatTile(load({ chats: 32, online: 1 }))).toMatchObject({
      sub: "1 user online",
      full: true,
    });
    expect(automationsTile(load()).sub).toBe("12 automations");
    expect(automationsTile(load({ waiting: 4 })).sub).toBe(
      "12 automations · 4 waiting",
    );
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
    expect(cachedLine(totals({ promptTokens: 0 }))).toBe("none yet");
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

  test("a model loses its org unless a bare word is left", () => {
    expect(shortModel("mlx-community/LFM2.5-8B")).toBe("LFM2.5-8B");
    expect(shortModel("openrouter/free")).toBe("openrouter/free");
    expect(shortModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
  });

  test("turn lengths and their bars", () => {
    expect(lengthWord(41_000)).toBe("41s");
    expect(lengthWord(200_000)).toBe("3m 20s");
    expect(lengthWord(120_000)).toBe("2m");
    expect(lengthWord(3_900_000)).toBe("1h 5m");
    const [done, running] = lengthBars([
      {
        provider: "mlx-serve",
        model: "ornith",
        turns: 65,
        medianMs: 18_000,
        slowestMs: 317_000,
      },
      {
        provider: "nim",
        model: "nemo",
        turns: 1,
        medianMs: null,
        slowestMs: null,
      },
    ]);
    expect(done).toMatchObject({
      label: "18s",
      hint: "65 turns · slowest 5m 17s",
    });
    expect(running).toMatchObject({ label: "running", hint: "1 turn" });
  });
});

describe("all time", () => {
  const all = (over: Partial<OverviewResponse["all"]> = {}) => ({
    ...totals(),
    since: new Date(2026, 8, 12).getTime(),
    ...over,
  });

  test("four figures and the instance's counts", () => {
    expect(allCells(all()).map((c) => [c.label, c.figure, c.sub])).toEqual([
      ["Chats", "100", "4% failed"],
      ["Automations", "20", "none failed"],
      ["Tokens", "1.2K", "38% cached"],
      ["Cost", "$4.12", "12 of 30 priced"],
    ]);
    expect(sinceWords(all().since)).toBe("since 12 Sep");
    expect(sinceWords(null)).toBe("");
    const instance: OverviewResponse["instance"] = {
      version: "v1.2.3",
      startedAt: 0,
      users: 8,
      projects: 5,
      agents: 9,
      automations: 1,
      databaseBytes: 0,
    };
    expect(instanceParts(instance).join(" · ")).toBe(
      "8 users · 9 agents · 5 team projects · 1 automation",
    );
    expect(buildLine(instance, 7 * 3_600_000)).toBe("v1.2.3 · up 7h");
  });
});

describe("the rail", () => {
  test("lights Storage alone under /admin/storage", () => {
    const hrefs = ["/admin", "/admin/storage", "/admin/tools"];
    expect(litPage("/admin/storage", hrefs)).toBe("/admin/storage");
    expect(litPage("/admin", hrefs)).toBe("/admin");
    expect(litPage("/admin/tools/web", hrefs)).toBe("/admin/tools");
    expect(litPage("/projects", hrefs)).toBeNull();
  });
});
