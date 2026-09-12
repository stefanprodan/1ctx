// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  access,
  cookieValue,
  LoginStore,
} from "../../../src/server/access/index.ts";
import { UserStore } from "../../../src/server/users/index.ts";
import { memoryDb } from "../../helpers/db.ts";

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
    const db = memoryDb();
    const users = new UserStore(db);
    const user = users.create({
      name: "u",
      role: "member",
      passwordHash: "x",
      now: 0,
    });
    const auth = access({
      logins: new LoginStore(db),
      user: (id) => users.byId(id),
      clock: () => 0,
      secureCookie: true,
    });
    expect(auth.open(user).setCookie).toMatch(/; Secure$/);
    expect(auth.clearCookie()).toMatch(/; Secure$/);
  });

  test("a login of a deleted user is nobody", () => {
    const db = memoryDb();
    const users = new UserStore(db);
    const user = users.create({
      name: "u",
      role: "member",
      passwordHash: "x",
      now: 0,
    });
    const auth = access({
      logins: new LoginStore(db),
      user: (id) => users.byId(id),
      clock: () => 0,
      secureCookie: false,
    });
    const { setCookie } = auth.open(user);
    const req = () =>
      new Request("http://x", { headers: { cookie: setCookie.split(";")[0] } });
    expect(auth.resolve(req()).principal?.name).toBe("u");
    db.query("delete from users where id = ?").run(user.id);
    expect(auth.resolve(req()).principal).toBeNull();
  });
});
