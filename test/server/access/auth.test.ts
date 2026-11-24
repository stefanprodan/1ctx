// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  accessArea,
  cookieValue,
  LOGIN_TTL_MS,
} from "../../../src/server/access/index.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { usersArea } from "../../../src/server/users/index.ts";
import { memoryDb } from "../../helpers/db.ts";

// the access area with fakes for its ports, except the user: a login
// row references its user row, so the one user comes from the real
// users area, itself over a fake projects port
const OPS_KEY = `1ctx-admin-${"o".repeat(43)}`;

function build(secureCookie: boolean) {
  const db = memoryDb();
  const files: Record<string, string> = { "user-ops": OPS_KEY };
  const now = { value: 0 };
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
    now: 0,
  });
  const access = accessArea({
    db,
    dictation: { enabled: () => false },
    keyFiles: {
      read: (name) => files[name] ?? null,
      list: () => Object.keys(files),
    },
    email: {
      enabled: () => false,
      link: () => {
        throw new Error("email is off");
      },
      enqueue: () => [],
      register: () => {},
      dropQueued: () => 0,
      hasQueued: () => false,
      countAsked: () => 0,
    },
    clock: () => now.value,
    log: silent,
    secureCookie,
    accessKeysPerUser: () => 5,
    taskClaims: { endForKeys: () => [], endForUser: () => [] },
    users,
    projects: {
      byId: () => null,
      isMember: () => false,
      memberProjectIds: () => [],
      teamProjectIds: () => [],
      visibleFor: () => [],
      personal: () => null,
    },
    usage: {
      projectTotal: () => ({ sends: 0, tokens: 0, cost: 0 }),
      activeProjects: () => [],
    },
    presence: { onlineUserIds: () => [] },
    activity: { personDays: (_userId, starts) => starts.map(() => 0) },
  });
  return { db, user, users, access, files, now };
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
    const { login, setCookie } = access.open(user, null);
    expect(setCookie).toMatch(/; Secure$/);
    expect(access.close(login.id)).toMatch(/; Secure$/);
  });

  test("a login of a deleted user is nobody", () => {
    const { db, user, access } = build(false);
    const { setCookie } = access.open(user, null);
    const req = () =>
      new Request("http://x", { headers: { cookie: setCookie.split(";")[0] } });
    expect(access.resolve(req(), "authenticated").principal?.username).toBe(
      "u",
    );
    db.query("delete from users where id = ?").run(user.id);
    expect(access.resolve(req(), "authenticated").principal).toBeNull();
  });

  test("a disabled user resolves and refreshes to nobody", () => {
    const { user, users, access } = build(false);
    const { setCookie } = access.open(user, null);
    const req = new Request("http://x", {
      headers: { cookie: setCookie.split(";")[0] },
    });
    const principal = access.resolve(req, "authenticated").principal!;
    users.setDisabled(user.id, true);
    expect(access.resolve(req, "authenticated").principal).toBeNull();
    expect(access.refresh(principal)).toBeNull();
  });

  test("a refresh needs the login's row, unexpired, whatever the socket heard", () => {
    const { db, user, users, access, now } = build(false);
    const principalOf = (setCookie: string) =>
      access.resolve(
        new Request("http://x", {
          headers: { cookie: setCookie.split(";")[0] },
        }),
        "authenticated",
      ).principal!;
    const gone = access.open(user, null);
    const deleted = principalOf(gone.setCookie);
    expect(access.refresh(deleted)?.username).toBe("u");
    db.query("delete from logins where id = ?").run(gone.login.id);
    expect(access.refresh(deleted)).toBeNull();
    // another user's login never refreshes this one
    const other = users.createUser({
      username: "w",
      fullName: "W",
      email: "w@example.com",
      role: "member",
      now: 0,
    });
    const theirs = access.open(other, null);
    expect(
      access.refresh({
        ...deleted,
        via: { kind: "login", id: theirs.login.id },
      }),
    ).toBeNull();
    const old = access.open(user, null);
    const expired = principalOf(old.setCookie);
    now.value = LOGIN_TTL_MS;
    expect(access.refresh(expired)).toBeNull();
    expect(
      db
        .query("select count(*) as n from logins where id = ?")
        .get(old.login.id),
    ).toEqual({ n: 0 });
  });

  test.serial(
    "a key login whose file changed resolves to nobody and is revoked",
    () => {
      const { db, users, access, files } = build(false);
      const ops = users.createUser({
        username: "ops",
        fullName: "Ops",
        email: "ops@example.com",
        role: "admin",
        now: 0,
      });
      const { login, setCookie } = access.open(ops, "0".repeat(64));
      files["user-ops"] = `1ctx-admin-${"n".repeat(43)}`;
      const events: BusEvent[] = [];
      const unsubscribe = subscribe((event) => events.push(event), silent);
      try {
        const req = new Request("http://x", {
          headers: { cookie: setCookie.split(";")[0] },
        });
        expect(access.resolve(req, "authenticated").principal).toBeNull();
      } finally {
        unsubscribe();
      }
      expect(events).toContainEqual({
        type: "login.revoked",
        data: { userId: ops.id, loginId: login.id },
      });
      expect(db.query("select count(*) as n from logins").get()).toEqual({
        n: 0,
      });
    },
  );

  test.serial("resolving an expired login publishes its revocation", () => {
    const { db, user, access } = build(false);
    const { login, setCookie } = access.open(user, null);
    db.query("update logins set expires_at = 0 where id = ?").run(login.id);
    const events: BusEvent[] = [];
    const unsubscribe = subscribe((event) => events.push(event), silent);
    try {
      const req = new Request("http://x", {
        headers: { cookie: setCookie.split(";")[0] },
      });
      expect(access.resolve(req, "authenticated").principal).toBeNull();
    } finally {
      unsubscribe();
    }
    expect(events).toContainEqual({
      type: "login.revoked",
      data: { userId: user.id, loginId: login.id },
    });
  });
});
