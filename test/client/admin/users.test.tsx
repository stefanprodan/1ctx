// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The words the users page shows, the checks its forms apply, the
// entity that follows the signed-in user, and the page rendered over
// the rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { me } from "../../../src/client/data/me.ts";
import {
  createUser,
  loadUsers,
  resetPassword,
  updateUser,
  users,
  usersError,
} from "../../../src/client/data/users.ts";
import { UserForm } from "../../../src/client/views/admin/UserForm.tsx";
import {
  adminCount,
  canReset,
  disableLock,
  emailProblem,
  metaLine,
  newPasswordProblem,
  patchOf,
  roleLock,
  sinceLine,
  stateLine,
  usernameProblem,
} from "../../../src/client/views/admin/Users.model.ts";
import { Users } from "../../../src/client/views/admin/Users.tsx";
import type { Me, UserAccount } from "../../../src/shared/contracts/user.ts";

const admin: Me = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  mustChangePassword: false,
};
const root: UserAccount = {
  id: "u1",
  username: "admin",
  fullName: "Stefan Prodan",
  role: "admin",
  email: "admin@1ctx.dev",
  tz: "UTC",
  createdAt: new Date(2026, 8, 12).getTime(),
  disabled: false,
  mustChangePassword: false,
};
const caelea: UserAccount = {
  id: "u2",
  username: "caelea",
  fullName: "Oana Mangiurea",
  role: "member",
  email: "caelea@example.com",
  tz: "Europe/Bucharest",
  createdAt: new Date(2026, 8, 13).getTime(),
  disabled: false,
  mustChangePassword: true,
};

const realFetch = globalThis.fetch;
let answer: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  me.value = admin;
  users.value = null;
  usersError.value = null;
  globalThis.fetch = (async (url: string, init?: RequestInit) =>
    answer(url, init)) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the words", () => {
  test("the handle with the email, and since when", () => {
    expect(metaLine(caelea)).toBe("@caelea · caelea@example.com");
    expect(sinceLine(caelea)).toBe("since 13 September 2026");
    expect(stateLine(root)).toBe("admin · since 12 September 2026");
    expect(stateLine(caelea)).toBe(
      "member · password to change · since 13 September 2026",
    );
    expect(stateLine({ ...caelea, disabled: true })).toBe(
      "member · disabled · since 13 September 2026",
    );
  });

  test("the disable lock: the admin's own row and the last enabled admin", () => {
    expect(disableLock(root, "u1", 1)).toContain("yourself");
    expect(disableLock(root, "u2", 1)).toContain("last admin");
    expect(disableLock(root, "u2", 2)).toBeNull();
    expect(disableLock(caelea, "u1", 1)).toBeNull();
    expect(
      adminCount([root, { ...caelea, role: "admin", disabled: true }]),
    ).toBe(1);
    expect(roleLock({ ...root, disabled: true }, "u2", 0)).toBeNull();
  });

  test("the role lock: the admin's own row and the last admin", () => {
    expect(roleLock(root, "u1", 1)).toContain("own role");
    expect(roleLock(root, "u2", 1)).toContain("last admin");
    expect(roleLock(root, "u2", 2)).toBeNull();
    expect(roleLock(caelea, "u1", 1)).toBeNull();
    expect(adminCount([root, caelea])).toBe(1);
  });

  test("the reset is for everyone but the admin's own row", () => {
    expect(canReset(caelea, "u1")).toBe(true);
    expect(canReset(root, "u1")).toBe(false);
  });
});

describe("the checks", () => {
  test("leaves the username rule to the server and catches an empty one", () => {
    expect(usernameProblem("caelea")).toBeNull();
    expect(usernameProblem("ab")).toBeNull();
    expect(usernameProblem("-caelea")).toBeNull();
    expect(usernameProblem("")).toBe("Enter a username");
    expect(usernameProblem("  ")).toBe("Enter a username");
  });

  test("the email rule", () => {
    expect(emailProblem("caelea@example.com")).toBeNull();
    expect(emailProblem(" Caelea@Example.com ")).toBeNull();
    expect(emailProblem("")).toBe("Enter an email");
    expect(emailProblem("caelea")).toBe("Not an email address");
    expect(emailProblem("caelea@example")).toBe("Not an email address");
    expect(emailProblem("caelea@.com")).toBe("Not an email address");
    expect(emailProblem("o ana@example.com")).toBe("Not an email address");
    expect(emailProblem(`${"a".repeat(250)}@b.co`)).toContain("under 254");
  });

  test("the password rule, typed twice", () => {
    expect(newPasswordProblem("longenough", "longenough")).toBeNull();
    expect(newPasswordProblem("short", "short")).toContain("at least 8");
    expect(newPasswordProblem("é".repeat(513), "é".repeat(513))).toContain(
      "at most 1024 bytes",
    );
    expect(newPasswordProblem("longenough", "longenougx")).toBe(
      "The two passwords differ",
    );
  });

  test("the patch carries only what changed, lowercased", () => {
    expect(
      patchOf(caelea, {
        username: "caelea",
        fullName: "Oana Mangiurea",
        email: "caelea@example.com",
        role: "member",
        tz: "Europe/Bucharest",
      }),
    ).toBeNull();
    expect(
      patchOf(caelea, {
        username: " oana2 ",
        fullName: "Oana Mangiurea",
        email: "Caelea@Example.com",
        role: "admin",
        tz: "Europe/Bucharest",
      }),
    ).toEqual({ username: "oana2", role: "admin" });
    expect(
      patchOf(caelea, {
        username: "caelea",
        fullName: "Oana",
        email: "o@example.com",
        role: "member",
        tz: "Asia/Tokyo",
      }),
    ).toEqual({ fullName: "Oana", email: "o@example.com", tz: "Asia/Tokyo" });
  });
});

describe("the entity", () => {
  test("loads for the signed-in user and drops with them", async () => {
    answer = () => Response.json({ users: [root, caelea] });
    await loadUsers();
    expect(users.value).toEqual([root, caelea]);
    me.value = null;
    expect(users.value).toBeNull();
  });

  test("a write puts the server's row in the list, by username", async () => {
    users.value = [root];
    answer = () => Response.json({ user: caelea });
    await createUser({
      username: "caelea",
      fullName: "Oana Mangiurea",
      email: "caelea@example.com",
      role: "member",
      tz: "Europe/Bucharest",
      password: "longenough",
    });
    expect(users.value).toEqual([root, caelea]);
    const renamed = { ...caelea, username: "a-caelea" };
    answer = () => Response.json({ user: renamed });
    await updateUser("u2", { username: "a-caelea" });
    expect(users.value).toEqual([renamed, root]);
  });

  test("a reset sends the password and reads the list again", async () => {
    users.value = [root, { ...caelea, mustChangePassword: false }];
    let sent: { url: string; body: unknown } | null = null as {
      url: string;
      body: unknown;
    } | null;
    answer = (url, init) => {
      if (init?.method !== "POST")
        return Response.json({ users: [root, caelea] });
      sent = { url, body: JSON.parse(String(init?.body)) };
      return new Response(null, { status: 204 });
    };
    await resetPassword("u2", { password: "longenough" });
    expect(sent).toEqual({
      url: "/api/users/u2/password",
      body: { password: "longenough" },
    });
    expect(users.value).toEqual([root, caelea]);
  });

  test("a refusal is the error shown", async () => {
    answer = () => Response.json({ error: "forbidden" }, { status: 403 });
    await loadUsers();
    expect(usersError.value).toBe("forbidden");
    expect(users.value).toBeNull();
  });
});

describe("the page", () => {
  test("the signed-in admin has no role choice or reset", () => {
    const html = render(<UserForm user={root} admins={1} onDone={() => {}} />);
    expect(html).not.toContain(">Role<");
    expect(html).not.toContain("Reset password");
  });

  test("renders every user with the handle, the email and the role", () => {
    users.value = [root, caelea];
    const html = render(<Users />);
    expect(html).toContain("Stefan Prodan");
    expect(html).toContain("@admin · admin@1ctx.dev");
    expect(html).toContain("@caelea · caelea@example.com");
    expect(html).toContain(
      "member · password to change · since 13 September 2026",
    );
    users.value = [root, { ...caelea, disabled: true }];
    expect(render(<Users />)).toContain("rows-item-off");
    expect(html).toContain(">you<");
    expect(html).toContain("New user");
    expect(html).not.toContain("passwordHash");
  });

  test("shows the load's refusal", () => {
    usersError.value = "forbidden";
    const html = render(<Users />);
    expect(html).toContain("forbidden");
  });
});
