// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words the users pages show, the checks their forms apply, the
// entity that follows the signed-in user, and the pages rendered over
// the rows.

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import {
  createUser,
  loadUsers,
  loadUserUsage,
  resetPassword,
  setUserProjects,
  updateUser,
  users,
  usersError,
  userUsage,
} from "../../../src/client/data/users.ts";
import { NewUser } from "../../../src/client/views/admin/NewUser.tsx";
import { UserPage } from "../../../src/client/views/admin/UserPage.tsx";
import {
  adminCount,
  disableLock,
  emailProblem,
  generatePassword,
  metaLine,
  passwordProblem,
  patchOf,
  roleLock,
  stateLine,
  userCounts,
  userFieldOf,
  usernameProblem,
} from "../../../src/client/views/admin/Users.model.ts";
import { Users } from "../../../src/client/views/admin/Users.tsx";
import type { AdminUser } from "../../../src/shared/api/users.ts";
import type { ProjectSummary } from "../../../src/shared/contracts/project.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";
import { admin as adminFixture, user } from "../../helpers/client-fixtures.ts";

const admin = adminFixture();
const NOW = Date.parse("2026-09-28T12:00:00Z");
const root = user({ lastVisitDay: "2026-09-28" });
const casey: AdminUser = {
  id: "u2",
  username: "casey",
  fullName: "Casey Doe",
  role: "member",
  email: "casey@example.com",
  tz: "Europe/Bucharest",
  createdAt: new Date(2026, 8, 13).getTime(),
  disabled: false,
  mustChangePassword: true,
  lastVisitDay: null,
  projectIds: ["p1"],
};
const team = (id: string, name: string): ProjectSummary => ({
  id,
  kind: "team",
  name,
  createdAt: 0,
  memberCount: 1,
});

let answer: (url: string, init?: RequestInit) => Response;
clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  // a new sign-in drops every answer, the aside's included
  me.value = null;
  me.value = admin;
  usersError.value = null;
  projects.value = null;
});

describe("the words", () => {
  test.serial(
    "the handle with the email, the role and when last active",
    () => {
      expect(metaLine(casey)).toBe("@casey · casey@example.com");
      expect(stateLine(root, NOW)).toBe("admin · active today");
      expect(stateLine(casey, NOW)).toBe("member · password to change");
      expect(stateLine({ ...casey, disabled: true }, NOW)).toBe(
        "member · disabled",
      );
      expect(stateLine({ ...casey, mustChangePassword: false }, NOW)).toBe(
        "member · never active",
      );
    },
  );

  test.serial("last active counts the user's own days, never hours", () => {
    const line = (lastVisitDay: string | null, tz = "UTC") =>
      stateLine({ ...root, lastVisitDay, tz }, NOW);
    expect(line("2026-09-28")).toBe("admin · active today");
    expect(line("2026-09-27")).toBe("admin · active yesterday");
    expect(line("2026-09-25")).toBe("admin · active 3d ago");
    expect(line(null)).toBe("admin · never active");
    // noon UTC is already the 29th on Kiritimati, whatever the reader's
    // zone
    expect(line("2026-09-28", "Pacific/Kiritimati")).toBe(
      "admin · active yesterday",
    );
    expect(line("2026-09-28", "Not/AZone")).toBe("admin · active today");
    // past four weeks the date itself, the year once it differs
    expect(line("2026-08-02")).toBe("admin · active 2 Aug");
    expect(line("2025-12-31")).toBe("admin · active 31 Dec 2025");
  });

  test.serial(
    "a generated password passes the rule and skips look-alikes",
    () => {
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const p = generatePassword();
        expect(p).toHaveLength(20);
        expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]+$/);
        expect(passwordProblem(p)).toBeNull();
        seen.add(p);
      }
      expect(seen.size).toBe(50);
    },
  );

  test.serial("the list's aside counts by role, the disabled apart", () => {
    expect(
      userCounts([root, casey, { ...casey, id: "u3", disabled: true }]),
    ).toEqual({ admins: 1, members: 2, disabled: 1 });
  });

  for (const [name, lock, self] of [
    ["disable", disableLock, "yourself"],
    ["role", roleLock, "own role"],
  ] as const) {
    test.serial(`${name} protects yourself and the last enabled admin`, () => {
      expect(lock(root, "u1", 1)).toContain(self);
      expect(lock(root, "u2", 1)).toContain("last admin");
      expect(lock(root, "u2", 2)).toBeNull();
      expect(lock(casey, "u1", 1)).toBeNull();
      expect(lock({ ...root, disabled: true }, "u2", 0)).toBeNull();
      expect(adminCount([root, casey])).toBe(1);
      expect(
        adminCount([root, { ...casey, role: "admin", disabled: true }]),
      ).toBe(1);
    });
  }
});

describe("the checks", () => {
  test.serial(
    "leaves the username rule to the server and catches an empty one",
    () => {
      expect(usernameProblem("casey")).toBeNull();
      expect(usernameProblem("ab")).toBeNull();
      expect(usernameProblem("-casey")).toBeNull();
      expect(usernameProblem("")).toBe("Enter a username");
      expect(usernameProblem("  ")).toBe("Enter a username");
    },
  );

  test.serial("the email rule", () => {
    expect(emailProblem("casey@example.com")).toBeNull();
    expect(emailProblem(" Casey@Example.com ")).toBeNull();
    expect(emailProblem("")).toBe("Enter an email");
    expect(emailProblem("casey")).toBe("Not an email address");
    expect(emailProblem("casey@example")).toBe("Not an email address");
    expect(emailProblem("casey@.com")).toBe("Not an email address");
    expect(emailProblem("o ana@example.com")).toBe("Not an email address");
    expect(emailProblem(`${"a".repeat(250)}@b.co`)).toContain("under 254");
  });

  test.serial("the password rule", () => {
    expect(passwordProblem("longenough")).toBeNull();
    expect(passwordProblem("short")).toContain("at least 8");
    expect(passwordProblem("é".repeat(513))).toContain("at most 1024 bytes");
  });

  test.serial("the patch carries only what changed, lowercased", () => {
    expect(
      patchOf(casey, {
        username: "casey",
        fullName: "Casey Doe",
        email: "casey@example.com",
        tz: "Europe/Bucharest",
      }),
    ).toBeNull();
    expect(
      patchOf(casey, {
        username: " casey2 ",
        fullName: "Casey Doe",
        email: "Casey@Example.com",
        tz: "Europe/Bucharest",
      }),
    ).toEqual({ username: "casey2" });
    expect(
      patchOf(casey, {
        username: "casey",
        fullName: "Casey",
        email: "o@example.com",
        tz: "Asia/Tokyo",
      }),
    ).toEqual({ fullName: "Casey", email: "o@example.com", tz: "Asia/Tokyo" });
  });
});

describe("the refusals", () => {
  test.serial("each server refusal names the field to fix", () => {
    expect(userFieldOf("username is taken")).toBe("username");
    expect(userFieldOf("username must be 3 to 32 lowercase")).toBe("username");
    expect(userFieldOf("full name must be 1 to 64 characters")).toBe(
      "fullName",
    );
    expect(userFieldOf("email is taken")).toBe("email");
    expect(userFieldOf("time zone must be an IANA zone name")).toBe("tz");
    expect(userFieldOf("cannot change your own role")).toBe("role");
    expect(userFieldOf("password must be a string of 8 to 1024 bytes")).toBe(
      "password",
    );
    expect(userFieldOf("the last admin must remain enabled")).toBeUndefined();
  });
});

describe("the entity", () => {
  test.serial("loads for the signed-in user and drops with them", async () => {
    answer = () => Response.json({ users: [root, casey] });
    await loadUsers();
    expect(users.value).toEqual([root, casey]);
    me.value = null;
    expect(users.value).toBeNull();
  });

  test.serial(
    "a write puts the server's row in the list, by username",
    async () => {
      users.value = [root];
      answer = () => Response.json({ user: casey });
      await createUser({
        username: "casey",
        fullName: "Casey Doe",
        email: "casey@example.com",
        role: "member",
        tz: "Europe/Bucharest",
        password: "longenough",
      });
      expect(users.value).toEqual([root, casey]);
      const renamed = { ...casey, username: "a-casey" };
      answer = () => Response.json({ user: renamed });
      await updateUser("u2", { username: "a-casey" });
      expect(users.value).toEqual([renamed, root]);
    },
  );

  test.serial(
    "a reset sends the password and reads the list again",
    async () => {
      users.value = [root, { ...casey, mustChangePassword: false }];
      let sent: { url: string; body: unknown } | null = null as {
        url: string;
        body: unknown;
      } | null;
      answer = (url, init) => {
        if (init?.method !== "POST")
          return Response.json({ users: [root, casey] });
        sent = { url, body: JSON.parse(String(init?.body)) };
        return new Response(null, { status: 204 });
      };
      await resetPassword("u2", { password: "longenough" });
      expect(sent).toEqual({
        url: "/api/users/u2/password",
        body: { password: "longenough" },
      });
      expect(users.value).toEqual([root, casey]);
    },
  );

  test.serial(
    "a projects save adds and removes one call each, then reads the list",
    async () => {
      const calls: string[] = [];
      answer = (url, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (url === "/api/users") return Response.json({ users: [root] });
        return Response.json({
          project: { ...team("p2", "ops"), description: "", members: [] },
        });
      };
      await setUserProjects(casey, ["p2"]);
      expect(calls.filter((c) => !c.startsWith("GET /api/projects"))).toEqual([
        "POST /api/projects/p2/members",
        "DELETE /api/projects/p1/members/u2",
        "GET /api/users",
      ]);
    },
  );

  test.serial(
    "a projects save that fails partway still reads the list again",
    async () => {
      const calls: string[] = [];
      answer = (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/users") return Response.json({ users: [root] });
        return Response.json({ error: "no such project" }, { status: 404 });
      };
      await expect(setUserProjects(casey, ["p2"])).rejects.toThrow();
      expect(calls).toEqual([
        "POST /api/projects/p2/members",
        "GET /api/users",
      ]);
      expect(users.value).toEqual([root]);
    },
  );

  test.serial(
    "a write that answers no row says when the list did not come back",
    async () => {
      answer = (_url, init) =>
        init?.method === "POST"
          ? new Response(null, { status: 204 })
          : Response.json({ error: "down" }, { status: 503 });
      users.value = [root, casey];
      await expect(
        resetPassword("u2", { password: "longenough" }),
      ).rejects.toThrow("down");
      await expect(setUserProjects(casey, ["p1"])).rejects.toThrow("down");
      // the page keeps the list it had
      expect(users.value).toEqual([root, casey]);
    },
  );

  test.serial("usage lands under its own user, a failure as null", async () => {
    const usage = { since: 0, until: 1, sends: 2, tokens: 10, cost: 0 };
    answer = (url) =>
      url.includes("/u1/")
        ? Response.json(usage)
        : Response.json({ error: "no" }, { status: 500 });
    await Promise.all([loadUserUsage("u2"), loadUserUsage("u1")]);
    expect(userUsage.valueFor("u1")).toEqual(usage);
    expect(userUsage.valueFor("u2")).toBeNull();
    expect(userUsage.valueFor("u3")).toBeUndefined();
    me.value = null;
    expect(userUsage.valueFor("u1")).toBeUndefined();
  });

  test.serial("a refusal is the error shown", async () => {
    answer = () => Response.json({ error: "forbidden" }, { status: 403 });
    await loadUsers();
    expect(usersError.value).toEqual({ words: "forbidden", status: 403 });
    expect(users.value).toBeNull();
  });
});

describe("the pages", () => {
  test.serial(
    "the list links every user with the handle, the email and the role",
    () => {
      users.value = [root, casey];
      const html = render(<Users />);
      expect(html).toContain("Stefan Prodan");
      expect(html).toContain("@admin · admin@1ctx.dev");
      expect(html).toContain("@casey · casey@example.com");
      expect(html).toContain('href="/admin/access/users/casey"');
      expect(html).toContain("member · password to change");
      expect(html).toContain(">you<");
      expect(html).toContain('href="/admin/access/users?new"');
      expect(html).toContain(">Admins<");
      expect(html).not.toContain("passwordHash");
    },
  );

  test.serial("the list shows the load's refusal", () => {
    usersError.value = { words: "forbidden", status: 403 };
    const html = render(<Users />);
    expect(html).toContain("This page did not load");
    expect(html).toContain("Forbidden.");
  });

  test.serial("New user asks who, the role and the password once", () => {
    users.value = [root];
    const html = render(<NewUser />);
    expect(html).toContain("Create user");
    expect(html).toContain('name="username"');
    expect(html).not.toContain('name="again"');
    expect(html).toContain('aria-label="Generate"');
    expect(html).toContain('aria-label="Show"');
    expect(html).toContain('aria-label="Copy"');
  });

  test.serial(
    "another user's page has every card and their personal usage",
    async () => {
      users.value = [root, casey];
      projects.value = [team("p1", "platform"), team("p2", "ops")];
      answer = () =>
        Response.json({
          since: 0,
          until: 1,
          sends: 4,
          tokens: 1200,
          cost: null,
        });
      await loadUserUsage("u2");
      const html = render(<UserPage params={{ username: "casey" }} />);
      expect(html).toContain('aria-label="Profile"');
      expect(html).toContain(">Role<");
      expect(html).not.toContain("Works in");
      expect(html).toContain(">platform<");
      expect(html).not.toContain(">ops<");
      expect(html).toContain("Reset password");
      expect(html).toContain("Disable @casey");
      expect(html).toContain("Personal, last 30 days");
      expect(html).toContain("1.2K");
      expect(html).toContain("not priced");
    },
  );

  test.serial(
    "the admin's own page fixes the role and has no reset or disable",
    () => {
      users.value = [root, casey];
      projects.value = [];
      const html = render(<UserPage params={{ username: "admin" }} />);
      expect(html).toContain("You cannot change your own role.");
      expect(html).not.toContain("Reset password");
      expect(html).not.toContain("Disable @admin");
    },
  );

  test.serial("a disabled user's page offers Enable", () => {
    users.value = [root, { ...casey, disabled: true }];
    projects.value = [];
    const html = render(<UserPage params={{ username: "casey" }} />);
    expect(html).toContain("Enable @casey");
    expect(html).toContain("They cannot sign in.");
  });

  test.serial("an unknown handle says so", () => {
    users.value = [root];
    const html = render(<UserPage params={{ username: "nobody" }} />);
    expect(html).toContain("No user by that name.");
  });
});
