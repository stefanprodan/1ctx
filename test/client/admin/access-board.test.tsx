// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  accessBoard,
  loadAccessBoard,
} from "../../../src/client/data/access-board.ts";
import { adminProjects } from "../../../src/client/data/admin-projects.ts";
import { me } from "../../../src/client/data/me.ts";
import { users } from "../../../src/client/data/users.ts";
import {
  accountGroups,
  projectGroups,
  signedInHint,
} from "../../../src/client/views/admin/AccessBoard.model.ts";
import { AccessBoard } from "../../../src/client/views/admin/AccessBoard.tsx";
import type { AccessBoardResponse } from "../../../src/shared/api/access.ts";
import type { AdminUser } from "../../../src/shared/api/users.ts";
import type { ProjectSummary } from "../../../src/shared/contracts/project.ts";

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
  activeProjectIds: [],
  ...over,
});

afterEach(() => {
  me.value = undefined;
  setSystemTime();
});

describe("the groups", () => {
  test("an account is in the first group that holds it", () => {
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
    expect(g.unseen.map((u) => u.username)).toEqual(["never", "gone"]);
    expect(g.password.map((u) => u.username)).toEqual(["handed"]);
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
    expect(g.unseen.map((u) => u.username)).toEqual(["east"]);
  });

  test("a project with nobody in it is not also quiet", () => {
    const g = projectGroups(
      [team("p1", "empty", 0), team("p2", "busy", 2), team("p3", "idle", 1)],
      ["p2"],
    );
    expect(g.empty.map((p) => p.name)).toEqual(["empty"]);
    expect(g.quiet.map((p) => p.name)).toEqual(["idle"]);
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
    expect(html).toContain(">Not seen in 30 days<");
    expect(html).toContain('href="/admin/access/users/never"');
    expect(html).toContain("never signed in");
    expect(html).toContain(">Projects without members<");
    expect(html).toContain('href="/admin/access/projects/p1"');
    expect(html).not.toContain(">Password to change<");
    expect(html).not.toMatch(/class="label" id="[^"]+">Disabled</);
    expect(html).not.toContain(">No activity in 30 days<");
    expect(html).not.toContain('href="/admin/access/users/fresh"');
    expect(html).toContain(">Team<");
    expect(html).toContain(">Personal<");
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
    asked = url;
    return Response.json(board());
  }) as unknown as typeof fetch;
  try {
    await loadAccessBoard();
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(asked).toStartWith("/api/admin/access?tz=");
  expect(accessBoard.value?.signedIn).toBe(2);
});
