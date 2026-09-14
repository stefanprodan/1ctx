// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { accessArea, cookieValue } from "../../../src/server/access/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { usersArea } from "../../../src/server/users/index.ts";
import { memoryDb } from "../../helpers/db.ts";

// the access area with fakes for its ports, except the user: a login
// row references its user row, so the one user comes from the real
// users area, itself over a fake projects port
function build(secureCookie: boolean) {
  const db = memoryDb();
  const users = usersArea({
    db,
    secret: () => null,
    clock: () => 0,
    log: silent,
    projects: { createPersonal: () => {} },
  });
  const user = users.createUser({
    username: "u",
    fullName: "U",
    email: "u@example.com",
    role: "member",
    passwordHash: "x",
    mustChangePassword: false,
    now: 0,
  });
  const access = accessArea({
    db,
    clock: () => 0,
    log: silent,
    secureCookie,
    users,
    projects: {
      byId: () => null,
      isMember: () => false,
      memberProjectIds: () => [],
      teamProjectIds: () => [],
      nameTaken: () => false,
      personal: () => null,
      renamePersonal: () => {},
    },
  });
  return { db, user, users, access };
}

describe("cookieValue", () => {
  test("finds the named cookie among others", () => {
    const req = new Request("http://x", {
      headers: { cookie: "a=1; login=tok; b=2" },
    });
    expect(cookieValue(req, "login")).toBe("tok");
    expect(cookieValue(req, "a")).toBe("1");
    expect(cookieValue(req, "nope")).toBeNull();
  });

  test("a prefix is not a match", () => {
    const req = new Request("http://x", { headers: { cookie: "loginx=1" } });
    expect(cookieValue(req, "login")).toBeNull();
  });
});

describe("access", () => {
  test("marks the cookie Secure when asked", () => {
    const { user, access } = build(true);
    expect(access.open(user).setCookie).toMatch(/; Secure$/);
    expect(access.clearCookie()).toMatch(/; Secure$/);
  });

  test("a login of a deleted user is nobody", () => {
    const { db, user, access } = build(false);
    const { setCookie } = access.open(user);
    const req = () =>
      new Request("http://x", { headers: { cookie: setCookie.split(";")[0] } });
    expect(access.resolve(req()).principal?.username).toBe("u");
    db.query("delete from users where id = ?").run(user.id);
    expect(access.resolve(req()).principal).toBeNull();
  });

  test("a disabled user resolves and refreshes to nobody", () => {
    const { user, users, access } = build(false);
    const { setCookie } = access.open(user);
    const req = new Request("http://x", {
      headers: { cookie: setCookie.split(";")[0] },
    });
    const principal = access.resolve(req).principal!;
    users.setDisabled(user.id, true);
    expect(access.resolve(req).principal).toBeNull();
    expect(access.refresh(principal)).toBeNull();
  });

  test("login cannot outlive a disable during password verification", async () => {
    const { db, user, users, access } = build(false);
    users.setPasswordHash(
      user.id,
      await Bun.password.hash("longenough", { algorithm: "argon2id" }),
    );
    const byUsername = users.byUsername;
    let first = true;
    users.byUsername = (username) => {
      const found = byUsername(username);
      if (first) {
        first = false;
        queueMicrotask(() => users.setDisabled(user.id, true));
      }
      return found;
    };
    const route = access.routes.find(
      (item) => item.method === "POST" && item.path === "/api/login",
    )!;
    const req = new Request("http://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", password: "longenough" }),
    });
    await expect(
      route.handle(req, {
        principal: null,
        params: {},
        url: new URL(req.url),
        address: "127.0.0.1",
      }),
    ).rejects.toThrow("wrong username or password");
    expect(db.query("select count(*) as n from logins").get()).toEqual({
      n: 0,
    });
  });

  test("resolving an expired login publishes its revocation", () => {
    const { db, user, access } = build(false);
    const { login, setCookie } = access.open(user);
    db.query("update logins set expires_at = 0 where id = ?").run(login.id);
    const events: BusEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event));
    try {
      const req = new Request("http://x", {
        headers: { cookie: setCookie.split(";")[0] },
      });
      expect(access.resolve(req).principal).toBeNull();
    } finally {
      unsubscribe();
    }
    expect(events).toContainEqual({
      type: "login.revoked",
      data: { userId: user.id, loginId: login.id },
    });
  });
});
