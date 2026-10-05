// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A decider's page draws its model, its answers per day, loaded apart
// from the page, and the decisions it answers by name alone; Manage is
// an admin's.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import {
  deciderDays,
  deciderDaysFailed,
  deciderPage,
  deciderPageError,
  loadDeciderDays,
  loadDeciderPage,
} from "../../../src/client/data/directory.ts";
import { me } from "../../../src/client/data/me.ts";
import { Decider } from "../../../src/client/views/directory/Decider.tsx";
import {
  deciderAnswer,
  deciderLine,
  decisionsMeta,
} from "../../../src/client/views/directory/Directory.model.ts";
import { ANSWER_WORDS } from "../../../src/client/views/projects/Activity.model.ts";
import type {
  DirectoryDeciderDaysResponse,
  DirectoryDeciderResponse,
} from "../../../src/shared/api/directory.ts";

const jev: DirectoryDeciderResponse = {
  decider: {
    id: "d1",
    name: "jev",
    model: "typesafe/jev-1.13",
    contextLength: 32_000,
    promptPrice: 0.05,
    default: true,
    createdAt: Date.UTC(2026, 8, 1),
  },
  provider: "router",
  decisions: ["run-attention"],
};

// two days, the decider busy on the second
const busy: DirectoryDeciderDaysResponse = {
  since: Date.UTC(2026, 8, 14),
  until: Date.UTC(2026, 8, 16),
  days: ["2026-09-14", "2026-09-15"],
  total: { answers: 12, tokens: 3_400 },
  usage: [
    { answers: 0, tokens: 0 },
    { answers: 12, tokens: 3_400 },
  ],
};

const empty: DirectoryDeciderDaysResponse = {
  ...busy,
  total: { answers: 0, tokens: 0 },
  usage: busy.usage.map(() => ({ answers: 0, tokens: 0 })),
};

const member = {
  id: "u1",
  username: "casey",
  fullName: "Casey Doe",
  role: "member" as const,
  mustChangePassword: false,
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  // a new user clears the held pages and days of the last test
  me.value = null;
  me.value = member;
  deciderPage.value = null;
  deciderPageError.value = null;
  deciderDays.value = null;
  deciderDaysFailed.value = false;
  path.value = "/deciders/jev";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the decider's loads", () => {
  test.serial("asks in the browser's zone and keeps the latest", async () => {
    const asked: string[] = [];
    const gates: (() => void)[] = [];
    globalThis.fetch = ((url: string) =>
      new Promise<Response>((resolve) => {
        asked.push(url);
        gates.push(() => resolve(Response.json(busy)));
      })) as unknown as typeof fetch;
    const first = loadDeciderDays("jev");
    const second = loadDeciderDays("kev");
    expect(asked[0]).toMatch(/^\/api\/directory\/deciders\/jev\/days\?tz=/);
    gates[1]();
    await second;
    gates[0]();
    await first;
    expect(deciderDays.value?.name).toBe("kev");
  });

  test.serial(
    "a failed first load is failed, a failed refresh keeps the days",
    async () => {
      let ok = false;
      globalThis.fetch = (async () =>
        ok
          ? Response.json(busy)
          : Response.json(
              { error: "down" },
              { status: 500 },
            )) as unknown as typeof fetch;
      await loadDeciderDays("jev");
      expect(deciderDays.value).toBeNull();
      expect(deciderDaysFailed.value).toBe(true);
      ok = true;
      await loadDeciderDays("jev");
      expect(deciderDaysFailed.value).toBe(false);
      ok = false;
      await loadDeciderDays("jev");
      expect(deciderDaysFailed.value).toBe(false);
      expect(deciderDays.value?.body).toEqual(busy);
    },
  );

  test.serial("a missing decider is the page's words and status", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "no such decider" },
        { status: 404 },
      )) as unknown as typeof fetch;
    await loadDeciderPage("nobody");
    expect(deciderPage.value).toBeNull();
    expect(deciderPageError.value).toEqual({
      words: "no such decider",
      status: 404,
    });
  });

  test.serial("a new user drops the page and the days", async () => {
    globalThis.fetch = (async (url: string) =>
      Response.json(url.includes("/days") ? busy : jev)) as typeof fetch;
    await Promise.all([loadDeciderPage("jev"), loadDeciderDays("jev")]);
    expect(deciderPage.value).toEqual(jev);
    me.value = null;
    expect(deciderPage.value).toBeNull();
    expect(deciderDays.value).toBeNull();
  });
});

describe("the decider's page", () => {
  test.serial("draws the model, the window, the price and no cost", () => {
    deciderPage.value = jev;
    deciderDays.value = { name: "jev", body: busy };
    const html = render(<Decider params={{ name: "jev" }} />);
    expect(html).toContain("typesafe/jev-1.13");
    expect(html).toContain("router · 32K · $0.05 input · default");
    expect(html).toContain("1 September 2026");
    expect(html).not.toContain("Manage");
    expect(html).not.toContain("cost");
  });

  test.serial("draws its ghost, then a busy year as answers", () => {
    deciderPage.value = jev;
    let html = render(<Decider params={{ name: "jev" }} />);
    expect(html).toContain('aria-label="Loading activity"');
    // another decider's days are not this one's
    deciderDays.value = { name: "kev", body: busy };
    html = render(<Decider params={{ name: "jev" }} />);
    expect(html).toContain('aria-label="Loading activity"');

    deciderDays.value = { name: "jev", body: busy };
    html = render(<Decider params={{ name: "jev" }} />);
    expect(html).not.toContain('aria-label="Loading activity"');
    expect(html).toContain(">12 answers · 3.4K tokens<");
    expect(html).toContain('aria-label="12 answers in 1 weeks"');

    deciderDays.value = { name: "jev", body: empty };
    html = render(<Decider params={{ name: "jev" }} />);
    expect(html).toContain(">0 answers · 0 tokens<");

    deciderDays.value = null;
    deciderDaysFailed.value = true;
    html = render(<Decider params={{ name: "jev" }} />);
    expect(html).not.toContain(">Activity<");
    expect(html).toContain(">Decisions<");
  });

  test.serial("lists each decision by its icon and name alone", () => {
    deciderPage.value = jev;
    const html = render(<Decider params={{ name: "jev" }} />);
    expect(html).toContain(">run-attention<");
    expect(html).not.toContain("Mark task runs");
    expect(html).not.toContain("Needs attention");
    deciderPage.value = { ...jev, decisions: [] };
    expect(render(<Decider params={{ name: "jev" }} />)).toContain(
      "No decision asks this decider.",
    );
  });

  test.serial("an admin gets Manage, to the decider's admin page", () => {
    me.value = { ...member, role: "admin" };
    deciderPage.value = jev;
    const html = render(<Decider params={{ name: "jev" }} />);
    expect(html).toContain('href="/admin/config/deciders/jev"');
    expect(html).toContain("Manage");
  });
});

describe("the decider page's words", () => {
  test("the line leaves out what the catalog did not say", () => {
    expect(
      deciderLine("kev-serve", {
        contextLength: null,
        promptPrice: null,
        default: false,
      }),
    ).toBe("kev-serve");
    expect(
      deciderLine("router", {
        contextLength: 1_000_000,
        promptPrice: 0,
        default: false,
      }),
    ).toBe("router · 1M · free");
  });

  test("a row's decisions, or none", () => {
    expect(decisionsMeta([])).toBe("none");
    expect(decisionsMeta(["run-attention"])).toBe("run-attention");
  });

  test("the days are one series of answers keyed by the decider", () => {
    expect(deciderAnswer(busy, "d1")).toEqual({
      since: busy.since,
      until: busy.until,
      days: busy.days,
      total: { sends: 12, tokens: 3_400 },
      projects: [
        {
          projectId: "d1",
          usage: [
            { sends: 0, tokens: 0 },
            { sends: 12, tokens: 3_400 },
          ],
        },
      ],
    });
  });

  test("an answer count is singular at one", () => {
    expect(ANSWER_WORDS.total({ sends: 1, tokens: 10 })).toBe(
      "1 answer · 10 tokens",
    );
    expect(
      ANSWER_WORDS.day({ day: "2026-09-15", sends: 2, tokens: 1_200 }),
    ).toBe("15 Sep · 2 answers · 1.2K tokens");
  });
});
