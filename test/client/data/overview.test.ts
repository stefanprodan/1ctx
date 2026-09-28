// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Overview's loads keep only the latest word: a slower answer, or
// one for a user who left, never lands over it, and a failed refresh
// keeps the answer on screen. The watch polls the load while the tab is
// seen, one poll at a time, and reads the days again every 30 seconds.
// Usage asks again for the current month alone, without dimming.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { me } from "../../../src/client/data/me.ts";
import {
  loadOverview,
  loadUsage,
  MONITOR_EVERY_MS,
  overview,
  overviewError,
  overviewLoading,
  serverLoad,
  serverLoadError,
  thisMonth,
  usageLoading,
  usageMonth,
  watchOverview,
  watchUsage,
} from "../../../src/client/data/overview.ts";
import {
  LOAD_SAMPLE_MS,
  type LoadResponse,
  type OverviewResponse,
} from "../../../src/shared/api/admin.ts";

const realFetch = globalThis.fetch;

const body = (readAt: number) => ({ readAt }) as unknown as OverviewResponse;

// each call waits for its own release, so a test picks the order
function held() {
  const calls: { url: string; answer: (res: Response) => void }[] = [];
  globalThis.fetch = ((url: string) =>
    new Promise<Response>((answer) => {
      calls.push({ url: String(url), answer });
    })) as unknown as typeof fetch;
  return calls;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey",
    role: "admin",
    mustChangePassword: false,
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  me.value = undefined;
});

describe("loadOverview", () => {
  test.serial("a later load wins over a slower earlier one", async () => {
    const calls = held();
    const first = loadOverview();
    const second = loadOverview();
    expect(calls[0].url).toMatch(
      /^\/api\/admin\/overview\?tz=[^&]+&range=30d$/,
    );
    calls[1].answer(json(body(7)));
    await second;
    calls[0].answer(json(body(30)));
    await first;
    expect(overview.value?.readAt).toBe(7);
    expect(overviewLoading.value).toBe(false);
  });

  test.serial("a failed refresh keeps the answer on screen", async () => {
    const calls = held();
    const load = loadOverview();
    calls[0].answer(json(body(1)));
    await load;
    const again = loadOverview();
    calls[1].answer(json({ error: "scan timed out" }, 500));
    await again;
    expect(overview.value?.readAt).toBe(1);
    expect(overviewError.value?.words).toBe("scan timed out");
    expect(overviewError.value?.status).toBe(500);
  });

  test.serial("an answer for a user who left is dropped", async () => {
    const calls = held();
    const load = loadOverview();
    me.value = {
      id: "u2",
      username: "other",
      fullName: "Other",
      role: "admin",
      mustChangePassword: false,
    };
    await settle();
    calls[0].answer(json(body(9)));
    await load;
    expect(overview.value).toBeNull();
    expect(overviewLoading.value).toBe(false);
  });
});

describe("watchOverview", () => {
  const loadBody = (at: number) => ({ at }) as unknown as LoadResponse;

  // a tab whose visibility, clock and timer the test drives
  const tab = () => {
    let hidden = false;
    let now = 0;
    const heard = new Set<() => void>();
    const ticks = new Set<() => void>();
    return {
      tab: {
        hidden: () => hidden,
        listen(change: () => void) {
          heard.add(change);
          return () => heard.delete(change);
        },
        now: () => now,
        every(_ms: number, tick: () => void) {
          ticks.add(tick);
          return () => ticks.delete(tick);
        },
      },
      set(state: "visible" | "hidden") {
        hidden = state === "hidden";
        for (const change of [...heard]) change();
      },
      // five seconds on
      tick() {
        now += LOAD_SAMPLE_MS;
        for (const tick of [...ticks]) tick();
      },
      timers: () => ticks.size,
    };
  };
  const loads = (calls: { url: string }[]) =>
    calls.filter((c) => c.url === "/api/admin/load").length;
  const overviews = (calls: { url: string }[]) =>
    calls.filter((c) => c.url.startsWith("/api/admin/overview")).length;

  test.serial("asks for the load at once, keeps it on a failure", async () => {
    const calls = held();
    const page = tab();
    const stop = watchOverview(page.tab);
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/load"]);
    calls[0].answer(json(loadBody(1)));
    await settle();
    expect(serverLoad.value?.at).toBe(1);
    page.tick();
    calls[1].answer(json({ error: "bad gateway" }, 502));
    await settle();
    expect(serverLoad.value?.at).toBe(1);
    expect(serverLoadError.value?.status).toBe(502);
    stop();
  });

  test.serial("says a first failure, with nothing to keep", async () => {
    const calls = held();
    const stop = watchOverview(tab().tab);
    calls[0].answer(json({ error: "bad gateway" }, 502));
    await settle();
    expect(serverLoad.value).toBeNull();
    expect(serverLoadError.value?.status).toBe(502);
    stop();
  });

  test.serial(
    "skips a tick while a poll waits, never dropping it",
    async () => {
      const calls = held();
      const page = tab();
      const stop = watchOverview(page.tab);
      page.tick();
      page.tick();
      expect(loads(calls)).toBe(1);
      calls[0].answer(json(loadBody(3)));
      await settle();
      expect(serverLoad.value?.at).toBe(3);
      page.tick();
      expect(loads(calls)).toBe(2);
      stop();
    },
  );

  test.serial("asks nothing hidden, and drops an answer out then", async () => {
    const calls = held();
    const page = tab();
    const stop = watchOverview(page.tab);
    page.set("hidden");
    expect(page.timers()).toBe(0);
    calls[0].answer(json(loadBody(5)));
    await settle();
    expect(serverLoad.value?.at).not.toBe(5);
    // seen again: asked at once
    page.set("visible");
    expect(loads(calls)).toBe(2);
    stop();
    expect(page.timers()).toBe(0);
    page.set("visible");
    expect(loads(calls)).toBe(2);
  });

  test.serial("reads the days again every period", async () => {
    const calls = held();
    const page = tab();
    const stop = watchOverview(page.tab);
    for (let i = 0; i < MONITOR_EVERY_MS / LOAD_SAMPLE_MS - 1; i++) {
      calls.at(-1)?.answer(json(loadBody(i)));
      await settle();
      page.tick();
    }
    expect(overviews(calls)).toBe(0);
    calls.at(-1)?.answer(json(loadBody(99)));
    await settle();
    page.tick();
    expect(overviews(calls)).toBe(1);
    stop();
  });
});

describe("watchUsage", () => {
  // a seen tab whose timer the test drives
  const tab = () => {
    const ticks = new Set<() => void>();
    let now = 0;
    return {
      tab: {
        hidden: () => false,
        listen: () => () => {},
        now: () => now,
        every(_ms: number, tick: () => void) {
          ticks.add(tick);
          return () => ticks.delete(tick);
        },
      },
      tick() {
        now += MONITOR_EVERY_MS;
        for (const tick of [...ticks]) tick();
      },
    };
  };
  const months = (calls: { url: string }[]) =>
    calls.filter((c) => c.url.startsWith("/api/admin/usage")).length;

  test.serial("asks for the current month again, quietly", async () => {
    const calls = held();
    const page = tab();
    const first = loadUsage(null);
    calls[0]!.answer(json({}));
    await first;
    const stop = watchUsage(page.tab);
    expect(months(calls)).toBe(1);
    page.tick();
    expect(months(calls)).toBe(2);
    expect(calls[1]!.url).toContain(`month=${thisMonth()}`);
    // the board stays undimmed while the poll's read is out
    expect(usageLoading.value).toBe(false);
    calls[1]!.answer(json({}));
    await settle();
    stop();
  });

  test.serial("never asks for a past month again", async () => {
    const calls = held();
    const page = tab();
    const first = loadUsage("2026-01");
    calls[0]!.answer(json({}));
    await first;
    expect(usageMonth.value).toBe("2026-01");
    const stop = watchUsage(page.tab);
    page.tick();
    expect(months(calls)).toBe(1);
    stop();
  });

  test.serial("two polls out at once never dim the board", async () => {
    const calls = held();
    const page = tab();
    const first = loadUsage(null);
    calls[0]!.answer(json({}));
    await first;
    const stop = watchUsage(page.tab);
    page.tick();
    page.tick();
    expect(months(calls)).toBe(3);
    expect(usageLoading.value).toBe(false);
    // the older answer lands after the newer and is dropped
    calls[2]!.answer(json({ at: 2 }));
    calls[1]!.answer(json({ at: 1 }));
    await settle();
    expect(usageLoading.value).toBe(false);
    stop();
  });

  test.serial(
    "follows the month at its midnight when none was named",
    async () => {
      setSystemTime(new Date(2026, 8, 30, 23, 59, 50));
      try {
        const calls = held();
        const page = tab();
        const first = loadUsage(null);
        calls[0]!.answer(json({}));
        await first;
        expect(usageMonth.value).toBe("2026-09");
        const stop = watchUsage(page.tab);
        setSystemTime(new Date(2026, 9, 1, 0, 0, 20));
        page.tick();
        expect(calls[1]!.url).toContain("month=2026-10");
        expect(usageMonth.value).toBe("2026-10");
        calls[1]!.answer(json({}));
        await settle();
        stop();
        // a named month stays put, and a past one is never asked again
        const named = loadUsage("2026-09");
        calls[2]!.answer(json({}));
        await named;
        const again = watchUsage(page.tab);
        page.tick();
        expect(months(calls)).toBe(3);
        again();
      } finally {
        setSystemTime();
      }
    },
  );
});
