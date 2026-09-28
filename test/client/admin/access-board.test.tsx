// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  accessBoard,
  BOARD_EVERY_MS,
  refreshAccessBoard,
  watchAccessBoard,
} from "../../../src/client/data/access-board.ts";
import { adminProjects } from "../../../src/client/data/admin-projects.ts";
import { me } from "../../../src/client/data/me.ts";
import { users } from "../../../src/client/data/users.ts";
import {
  accountGroups,
  projectGroups,
  recentUsers,
  recentWhen,
  signedInHint,
} from "../../../src/client/views/admin/AccessBoard.model.ts";
import { AccessBoard } from "../../../src/client/views/admin/AccessBoard.tsx";
import type { AccessBoardResponse } from "../../../src/shared/api/access.ts";
import type { AdminUser } from "../../../src/shared/api/users.ts";
import type { ProjectSummary } from "../../../src/shared/contracts/project.ts";
import { pollTab } from "../../helpers/poll.ts";

const NOW = Date.parse("2026-09-28T12:00:00Z");

const person = (
  id: string,
  username: string,
  over: Partial<AdminUser> = {},
): AdminUser => ({
  id,
  username,
  fullName: `${username[0]!.toUpperCase()}${username.slice(1)} Doe`,
  role: "member",
  email: `${username}@example.com`,
  tz: "UTC",
  createdAt: 0,
  disabled: false,
  mustChangePassword: false,
  lastVisitDay: "2026-09-28",
  projectIds: [],
  ...over,
});

const team = (
  id: string,
  name: string,
  memberCount: number,
): ProjectSummary => ({
  id,
  kind: "team",
  name,
  createdAt: Date.parse("2026-09-14T00:00:00Z"),
  memberCount,
});

const board = (
  over: Partial<AccessBoardResponse> = {},
): AccessBoardResponse => ({
  since: 0,
  until: 1,
  days: [
    {
      day: "2026-09-27",
      start: Date.parse("2026-09-27T00:00:00Z"),
      signedIn: 1,
    },
    {
      day: "2026-09-28",
      start: Date.parse("2026-09-28T00:00:00Z"),
      signedIn: 2,
    },
  ],
  signedIn: 2,
  recent: [],
  activeProjectIds: [],
  ...over,
});

afterEach(() => {
  me.value = undefined;
  setSystemTime();
});

describe("the groups", () => {
  test("an account is disabled, else inactive past 30 days", () => {
    const g = accountGroups(
      [
        person("u1", "fresh"),
        person("u2", "never", { lastVisitDay: null }),
        person("u3", "gone", { lastVisitDay: "2026-08-29" }),
        person("u4", "recent", { lastVisitDay: "2026-08-30" }),
        person("u5", "handed", {
          mustChangePassword: true,
          lastVisitDay: null,
        }),
        person("u6", "off", { disabled: true, mustChangePassword: true }),
      ],
      NOW,
    );
    expect(g.inactive.map((u) => u.username)).toEqual([
      "never",
      "gone",
      "handed",
    ]);
    expect(g.disabled.map((u) => u.username)).toEqual(["off"]);
  });

  test("idle days are the user's own, whatever the reader's zone", () => {
    // noon UTC is already the next day at UTC+14
    const g = accountGroups(
      [
        person("u1", "west", { lastVisitDay: "2026-08-30" }),
        person("u2", "east", {
          lastVisitDay: "2026-08-30",
          tz: "Pacific/Kiritimati",
        }),
      ],
      NOW,
    );
    expect(g.inactive.map((u) => u.username)).toEqual(["east"]);
  });

  test("the recent users keep the server's order, an unknown one left out", () => {
    const list = [person("u1", "first"), person("u2", "second")];
    const rows = recentUsers(
      [
        { userId: "u2", at: 50, online: true },
        { userId: "gone", at: 200, online: false },
        { userId: "u1", at: 100, online: false },
      ],
      list,
    );
    expect(rows.map((r) => r.user.username)).toEqual(["second", "first"]);
  });

  test("a project with nobody in it is not also quiet", () => {
    const g = projectGroups(
      [team("p1", "empty", 0), team("p2", "busy", 2), team("p3", "idle", 1)],
      ["p2"],
    );
    expect(g.empty.map((p) => p.name)).toEqual(["empty"]);
    expect(g.quiet.map((p) => p.name)).toEqual(["idle"]);
  });

  test("a recent user with a tab open is online, else how long ago", () => {
    const at = NOW - 5 * 60_000;
    expect(recentWhen({ userId: "u1", at, online: true }, NOW)).toBe("online");
    expect(recentWhen({ userId: "u1", at, online: false }, NOW)).toBe("5m ago");
  });

  test("the chart's line says the span, or the day under the pointer", () => {
    expect(signedInHint(3, 9, null)).toBe("3 users of 9 in 30 days");
    expect(signedInHint(1, 1, null)).toBe("1 user of 1 in 30 days");
    expect(
      signedInHint(3, 9, {
        day: "2026-09-27",
        start: new Date(2026, 8, 27).getTime(),
        signedIn: 1,
      }),
    ).toBe("27 Sep · 1 user");
  });
});

describe("the page", () => {
  test.serial("draws a card only for a group that holds any", () => {
    setSystemTime(NOW);
    users.value = [
      person("u1", "fresh"),
      person("u2", "never", { lastVisitDay: null }),
    ];
    adminProjects.value = [team("p1", "empty", 0), team("p2", "busy", 1)];
    accessBoard.value = board({ activeProjectIds: ["p2"] });
    const html = render(<AccessBoard />);
    expect(html).toContain(">Signed in<");
    expect(html).toContain(">Inactive<");
    expect(html).toContain('href="/admin/access/users/never"');
    expect(html).toContain("never signed in");
    expect(html).toContain(">Projects without members<");
    expect(html).toContain('href="/admin/access/projects/p1"');
    expect(html).not.toMatch(/class="label" id="[^"]+">Disabled</);
    expect(html).not.toContain(">Recently active<");
    expect(html).not.toContain('href="/admin/access/users/fresh"');
    expect(html).toContain(">Team<");
    expect(html).toContain(">Personal<");
  });

  test.serial("lists who used the app last under the chart", () => {
    setSystemTime(NOW);
    users.value = [person("u1", "fresh")];
    adminProjects.value = [];
    accessBoard.value = board({
      recent: [{ userId: "u1", at: NOW - 5 * 60_000, online: false }],
    });
    const html = render(<AccessBoard />);
    expect(html).toContain(">Recently active<");
    expect(html).toContain('href="/admin/access/users/fresh"');
    expect(html).toContain("5m ago");
    expect(html.indexOf(">Signed in<")).toBeLessThan(
      html.indexOf(">Recently active<"),
    );
  });

  test.serial("inactive opens on projects when no user is inactive", () => {
    setSystemTime(NOW);
    users.value = [person("u1", "fresh")];
    adminProjects.value = [team("p1", "idle", 1)];
    accessBoard.value = board();
    const html = render(<AccessBoard />);
    expect(html).toContain(">Inactive<");
    expect(html).toContain('href="/admin/access/projects/p1"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Projects</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Users</);
  });

  test.serial("says nobody signed in over an empty span", () => {
    users.value = [person("u1", "fresh")];
    adminProjects.value = [];
    accessBoard.value = board({
      signedIn: 0,
      days: board().days.map((d) => ({ ...d, signedIn: 0 })),
    });
    const html = render(<AccessBoard />);
    expect(html).toContain("Nobody signed in");
  });
});

test.serial("loads the board in the browser's zone", async () => {
  const realFetch = globalThis.fetch;
  let asked = "";
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/users") return Response.json({ users: [] });
    if (url === "/api/projects") return Response.json({ projects: [] });
    asked = url;
    return Response.json(board());
  }) as unknown as typeof fetch;
  try {
    await refreshAccessBoard();
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(asked).toStartWith("/api/admin/access?tz=");
  expect(accessBoard.value?.signedIn).toBe(2);
});

test.serial(
  "asks again every period while seen, never while hidden",
  async () => {
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      if (url.startsWith("/api/admin/access")) return Response.json(board());
      if (url === "/api/users") return Response.json({ users: [] });
      return Response.json({ projects: [] });
    }) as unknown as typeof fetch;
    const page = pollTab(BOARD_EVERY_MS);
    try {
      const stop = watchAccessBoard(page.tab);
      // the route has just loaded: nothing at once
      expect(asked).toEqual([]);
      page.tick();
      expect(asked).toHaveLength(3);
      expect(asked[0]).toStartWith("/api/admin/access?tz=");
      expect(asked.slice(1)).toEqual(["/api/users", "/api/projects"]);
      page.set("hidden");
      expect(page.timers()).toBe(0);
      page.tick();
      expect(asked).toHaveLength(3);
      // seen again past a period: at once
      page.set("visible");
      expect(asked).toHaveLength(6);
      stop();
      expect(page.timers()).toBe(0);
      expect(page.listeners()).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  },
);
