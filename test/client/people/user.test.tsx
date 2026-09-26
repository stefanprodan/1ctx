// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A user's page draws their actions per day as one number, loaded apart
// from the page, and its tabs are addresses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import {
  loadPersonDays,
  person,
  personDays,
  personDaysFailed,
} from "../../../src/client/data/directory.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  personAnswer,
  userTab,
  userTabs,
} from "../../../src/client/views/people/People.model.ts";
import { User } from "../../../src/client/views/people/User.tsx";
import { ACTION_WORDS } from "../../../src/client/views/projects/Activity.model.ts";
import type {
  DirectoryUserDaysResponse,
  DirectoryUserResponse,
} from "../../../src/shared/api/directory.ts";

const bogdan: DirectoryUserResponse = {
  user: {
    id: "u2",
    username: "bogdan",
    fullName: "Bogdan P",
    role: "member",
    email: "bogdan@example.com",
    tz: "UTC",
    about: "",
    createdAt: 0,
    disabled: false,
  },
  projects: [
    { id: "p2", kind: "team", name: "ops", createdAt: 0, memberCount: 3 },
    { id: "p3", kind: "team", name: "web", createdAt: 0, memberCount: 2 },
  ],
};

// two days, the person busy on the second
const days: DirectoryUserDaysResponse = {
  since: Date.UTC(2026, 8, 14),
  until: Date.UTC(2026, 8, 16),
  days: ["2026-09-14", "2026-09-15"],
  total: 5,
  usage: [0, 5],
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey Doe",
    role: "member",
    mustChangePassword: false,
  };
  person.value = null;
  personDays.value = null;
  personDaysFailed.value = false;
  path.value = "/users/bogdan";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the person's days", () => {
  test.serial(
    "asks for the person.s own days and keeps the latest",
    async () => {
      const asked: string[] = [];
      const gates: (() => void)[] = [];
      globalThis.fetch = ((url: string) =>
        new Promise<Response>((resolve) => {
          asked.push(url);
          gates.push(() => resolve(Response.json(days)));
        })) as unknown as typeof fetch;
      const first = loadPersonDays("bogdan");
      const second = loadPersonDays("elena");
      expect(asked[0]).toBe("/api/directory/users/bogdan/days");
      gates[1]();
      await second;
      gates[0]();
      await first;
      expect(personDays.value?.username).toBe("elena");
    },
  );

  test.serial(
    "a failed first load is failed, a failed refresh keeps the days",
    async () => {
      let ok = false;
      globalThis.fetch = (async () =>
        ok
          ? Response.json(days)
          : Response.json(
              { error: "down" },
              { status: 500 },
            )) as unknown as typeof fetch;
      await loadPersonDays("bogdan");
      expect(personDays.value).toBeNull();
      expect(personDaysFailed.value).toBe(true);
      ok = true;
      await loadPersonDays("bogdan");
      expect(personDaysFailed.value).toBe(false);
      expect(personDays.value?.body).toEqual(days);
      ok = false;
      await loadPersonDays("bogdan");
      expect(personDaysFailed.value).toBe(false);
      expect(personDays.value?.body).toEqual(days);
    },
  );

  test.serial("a failed load forgets the held days of that name", async () => {
    globalThis.fetch = (async () =>
      Response.json(days)) as unknown as typeof fetch;
    await loadPersonDays("bogdan");
    await loadPersonDays("elena");
    globalThis.fetch = (async () =>
      Response.json(
        { error: "no such user" },
        { status: 404 },
      )) as unknown as typeof fetch;
    await loadPersonDays("bogdan");
    const gates: (() => void)[] = [];
    globalThis.fetch = ((_url: string) =>
      new Promise<Response>((resolve) => {
        gates.push(() => resolve(Response.json(days)));
      })) as unknown as typeof fetch;
    const elena = loadPersonDays("elena");
    gates[0]();
    await elena;
    const again = loadPersonDays("bogdan");
    expect(personDays.value).toBeNull();
    gates[1]();
    await again;
  });

  test.serial("a new user drops the days and their failure", async () => {
    globalThis.fetch = (async () =>
      Response.json(days)) as unknown as typeof fetch;
    await loadPersonDays("bogdan");
    personDaysFailed.value = true;
    me.value = null;
    expect(personDays.value).toBeNull();
    expect(personDaysFailed.value).toBe(false);
  });
});

describe("the user page's activity", () => {
  test.serial("draws its ghost, then the days as actions", () => {
    person.value = bogdan;
    let html = render(<User params={{ username: "bogdan" }} />);
    expect(html).toContain('aria-label="Loading activity"');
    // another person's days are not this one's
    personDays.value = { username: "elena", body: days };
    html = render(<User params={{ username: "bogdan" }} />);
    expect(html).toContain('aria-label="Loading activity"');

    personDays.value = { username: "bogdan", body: days };
    html = render(<User params={{ username: "bogdan" }} />);
    expect(html).not.toContain('aria-label="Loading activity"');
    expect(html).toContain(">5 actions<");
    expect(html).not.toContain("tokens");
    expect(html).toContain('aria-label="5 actions in 1 weeks"');
    expect(html).toContain(
      'data-index="1" class="activity-cell activity-level-4"',
    );

    personDays.value = null;
    personDaysFailed.value = true;
    html = render(<User params={{ username: "bogdan" }} />);
    expect(html).not.toContain(">Activity<");
    expect(html).toContain(">About<");
  });
});

describe("the user page's About", () => {
  test.serial("ends on the time where the user is", () => {
    person.value = {
      ...bogdan,
      user: { ...bogdan.user, tz: "Europe/Bucharest", about: "Head of SRE." },
    };
    const html = render(<User params={{ username: "bogdan" }} />);
    expect(html).toContain(">Head of SRE.<");
    expect(html).toMatch(
      /class="people-foot">.*Local time<\/span>\d\d:\d\d · GMT\+[23]</,
    );
  });

  test.serial("drops the time for a zone the browser does not know", () => {
    person.value = { ...bogdan, user: { ...bogdan.user, tz: "Nowhere/Land" } };
    const html = render(<User params={{ username: "bogdan" }} />);
    expect(html).toContain("Nothing written yet.");
    expect(html).not.toContain("people-foot");
  });
});

describe("the user page's words", () => {
  test("a tab is found by its address, About for any other", () => {
    expect(userTab("/users/bogdan", "bogdan")).toBe(0);
    expect(userTab("/users/bogdan/projects", "bogdan")).toBe(1);
    expect(userTab("/users/bogdan/nope", "bogdan")).toBe(0);
    expect(userTab("/users/elena/projects", "bogdan")).toBe(0);
  });

  test("the tabs count the projects in common", () => {
    expect(
      userTabs("bogdan", bogdan).map((t) => [t.label, t.href, t.count]),
    ).toEqual([
      ["About", "/users/bogdan", undefined],
      ["Projects", "/users/bogdan/projects", 2],
    ]);
  });

  test("the days are one series of actions with no tokens", () => {
    expect(personAnswer(days, "u2")).toEqual({
      since: days.since,
      until: days.until,
      days: days.days,
      total: { sends: 5, tokens: 0 },
      projects: [
        {
          projectId: "u2",
          usage: [
            { sends: 0, tokens: 0 },
            { sends: 5, tokens: 0 },
          ],
        },
      ],
    });
  });

  test("an action count reads as one number, singular at one", () => {
    expect(ACTION_WORDS.total({ sends: 1, tokens: 0 })).toBe("1 action");
    expect(ACTION_WORDS.total({ sends: 1234, tokens: 0 })).toBe(
      "1,234 actions",
    );
    expect(ACTION_WORDS.day({ day: "2026-09-03", sends: 5, tokens: 0 })).toBe(
      "3 Sep · 5 actions",
    );
    expect(ACTION_WORDS.grid(0, 26)).toBe("0 actions in 26 weeks");
  });
});
