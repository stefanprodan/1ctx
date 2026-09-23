// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { litPage } from "../../../src/client/app/Rail.model.ts";
import { rangeOf } from "../../../src/client/data/overview.ts";
import {
  cachedLine,
  change,
  costTile,
  dayLine,
  lengthWord,
  modelBars,
  money,
  runningTile,
  sendsLine,
  shortModel,
  usageBars,
} from "../../../src/client/views/admin/Overview.model.ts";
import type {
  OverviewTotals,
  UsageRow,
} from "../../../src/shared/api/admin.ts";

const totals = (over: Partial<OverviewTotals> = {}): OverviewTotals => ({
  sends: 100,
  failed: 4,
  promptTokens: 1000,
  cachedTokens: 380,
  completionTokens: 200,
  rounds: 30,
  pricedRounds: 12,
  cost: 4.123,
  ...over,
});

const row = (over: Partial<UsageRow>): UsageRow => ({
  id: "a1",
  name: "platform",
  owner: null,
  sub: null,
  tokens: 600,
  sends: 3,
  failed: 0,
  cost: null,
  ...over,
});

describe("overview words", () => {
  test("the range comes from the address, 30 days by default", () => {
    expect(rangeOf(new URLSearchParams("days=7"))).toBe(7);
    expect(rangeOf(new URLSearchParams("days=90"))).toBe(90);
    expect(rangeOf(new URLSearchParams("days=12"))).toBe(30);
    expect(rangeOf(new URLSearchParams(""))).toBe(30);
  });

  test("a change against the range before says what there was", () => {
    expect(change(112, 100, 30)).toBe("+12% on the 30 days before");
    expect(change(50, 100, 7)).toBe("-50% on the 7 days before");
    expect(change(100, 100, 30)).toBe("same as the 30 days before");
    expect(change(5, 0, 30)).toBe("none the 30 days before");
    expect(change(0, 0, 30)).toBe("none the 30 days before either");
  });

  test("the sends and tokens tiles", () => {
    expect(sendsLine(totals(), totals({ sends: 80 }), 30)).toBe(
      "4% failed · +25% on the 30 days before",
    );
    expect(sendsLine(totals({ failed: 0 }), totals(), 30)).toBe(
      "none failed · same as the 30 days before",
    );
    expect(cachedLine(totals())).toBe("38% of the prompt cached");
    expect(cachedLine(totals({ promptTokens: 0 }))).toBe("no prompt tokens");
  });

  test("cost is never $0 when no round was priced", () => {
    expect(costTile(totals())).toEqual({
      figure: "$4.12",
      sub: "12 rounds of 30 priced",
    });
    expect(costTile(totals({ cost: null })).figure).toBe("None");
    expect(costTile(totals({ cost: null, rounds: 0 })).sub).toBe(
      "no rounds in the range",
    );
    expect(money(0.004)).toBe("<$0.01");
  });

  test("running now against the caps", () => {
    expect(
      runningTile({
        chats: 2,
        chatsCap: 32,
        runs: 1,
        runsCap: 32,
        online: 4,
      }),
    ).toEqual({
      figure: "3",
      unit: "sends",
      sub: "2 chats of 32 · 1 run of 32 · 4 online",
      share: 3 / 64,
    });
  });

  test("a day's words", () => {
    expect(
      dayLine({
        day: "2026-09-23",
        start: new Date(2026, 8, 23).getTime(),
        sends: 12,
        failed: 1,
        promptTokens: 1000,
        cachedTokens: 500,
        completionTokens: 234,
      }),
    ).toBe("Wed 23 Sep · 1.23k tokens · 50% cached · 12 sends · 1 failed");
  });

  test("a personal project's rows name only the owner", () => {
    const bars = usageBars(
      "projects",
      [row({}), row({ id: null, name: null, owner: "alice", tokens: 400 })],
      1000,
    );
    expect(bars.map((b) => [b.name, b.share, b.mono])).toEqual([
      ["platform", "60%", true],
      ["personal of @alice", "40%", false],
    ]);
    const tasks = usageBars(
      "tasks",
      [row({ id: null, name: null, owner: "alice", sub: "secret" })],
      1000,
    );
    expect(tasks[0].name).toBe("a task of @alice");
    expect(tasks[0].hint).not.toContain("secret");
  });

  test("a breakdown's hint carries sends, failures and cost", () => {
    const [bar] = usageBars(
      "models",
      [row({ name: "gpt", sub: "openrouter", failed: 1, cost: 1.5 })],
      600,
    );
    expect(bar.hint).toBe(
      "gpt · openrouter · 600 tokens, 100% · 3 sends · 1 failed · $1.50",
    );
  });

  test("a model loses its org unless a bare word is left", () => {
    expect(shortModel("mlx-community/LFM2.5-8B")).toBe("LFM2.5-8B");
    expect(shortModel("openrouter/free")).toBe("openrouter/free");
    expect(shortModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
  });

  test("send lengths and the model bars", () => {
    expect(lengthWord(41_000)).toBe("41s");
    expect(lengthWord(200_000)).toBe("3m 20s");
    expect(lengthWord(120_000)).toBe("2m");
    expect(lengthWord(3_900_000)).toBe("1h 5m");
    const [bar] = modelBars([
      {
        provider: "mlx-serve",
        model: "ornith",
        sends: 20,
        failed: 1,
        medianMs: 41_000,
        slowestMs: 720_000,
        medianRounds: 4,
      },
    ]);
    expect(bar.label).toBe("41s");
    expect(bar.hint).toBe(
      "ornith · mlx-serve · 20 sends · 5% failed · slowest 12m · median 4 rounds",
    );
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
