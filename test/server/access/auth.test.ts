// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { accessArea, cookieValue } from "../../../src/server/access/index.ts";
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
    role: "member",
    passwordHash: "x",
    now: 0,
  });
  const access = accessArea({
    db,
    clock: () => 0,
    log: silent,
    secureCookie,
    users,
    projects: { byId: () => null, isMember: () => false },
  });
  return { db, user, access };
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
});
