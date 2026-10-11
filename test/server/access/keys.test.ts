// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { accessArea } from "../../../src/server/access/index.ts";
import { AccessKeyStore } from "../../../src/server/access/key-store.ts";
import { transact } from "../../../src/server/db/index.ts";
import { jsonBody } from "../../../src/server/lib/body.ts";
import { DAY_MS, MINUTE_MS } from "../../../src/server/lib/clock.ts";
import {
  Forbidden,
  NotFound,
  Unauthorized,
} from "../../../src/server/lib/errors.ts";
import {
  json,
  type Principal,
  type RouteDescriptor,
} from "../../../src/server/lib/http.ts";
import { sha256 } from "../../../src/server/lib/ids.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { ProjectStore } from "../../../src/server/projects/index.ts";
import { usersArea } from "../../../src/server/users/index.ts";
import { router, sameOrigin } from "../../../src/server/web/router.ts";
import { KEY_REQUEST } from "../../helpers/access-keys.ts";
import { collectLogs } from "../../helpers/app.ts";
import { memoryDb } from "../../helpers/db.ts";

function build() {
  const db = memoryDb();
  const now = { value: 1_000_000 };
  const cap = { value: 5 };
  const projects = new ProjectStore(db);
  const users = usersArea({
    db,
    secret: () => null,
    clock: () => now.value,
    log: silent,
    projects,
  });
  const user = users.createUser({
    username: "casey",
    fullName: "Casey",
    email: "casey@example.test",
    role: "member",
    passwordHash: "unused",
    mustChangePassword: false,
    now: now.value,
  });
  const keys = new AccessKeyStore(db);
  const logs = collectLogs();
  const access = accessArea({
    db,
    clock: () => now.value,
    log: logs.logFactory("access"),
    secureCookie: false,
    accessKeysPerUser: () => cap.value,
    users,
    projects,
    usage: {
      projectTotal: () => ({ sends: 0, tokens: 0, cost: 0 }),
      activeProjects: () => [],
    },
    presence: { onlineUserIds: () => [] },
    activity: { personDays: (_id, starts) => starts.map(() => 0) },
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
  });
  const make = (projectIds: string[] | null = null) =>
    keys.create(user.id, { ...KEY_REQUEST, projectIds }, now.value);
  const request = (token: string, headers: Record<string, string> = {}) =>
    new Request("http://app.test/key-test", {
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  const principal = (token: string): Principal =>
    access.resolve(request(token), "key").principal!;
  const routes: RouteDescriptor[] = (["GET", "POST"] as const).map(
    (method) => ({
      method,
      path: "/key-test",
      policy: "key",
      handle: (_req, ctx) => json(ctx.principal),
    }),
  );
  const handle = (trustProxy = false, given = routes) =>
    router({
      routes: given,
      resolve: (req, policy) => access.resolve(req, policy),
      trustProxy,
      log: logs.logFactory("router"),
    });
  const call = async (
    headers: Record<string, string> = {},
    method = "POST",
    trustProxy = false,
  ) =>
    (await handle(trustProxy)(
      new Request("http://app.test/key-test", { method, headers }),
      "127.0.0.1",
    ))!;
  return {
    db,
    now,
    cap,
    users,
    user,
    projects,
    keys,
    logs,
    access,
    make,
    request,
    principal,
    handle,
    call,
  };
}

describe("access key storage", () => {
  test("keeps only a hash, round-trips restrictions and touches at most once a minute", () => {
    const b = build();
    try {
      const own = b.projects.personal(b.user.id)!;
      const { key, token } = b.make([own.id]);
      expect(token).toMatch(/^1ctx_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token.slice(5), "base64url")).toHaveLength(32);
      expect(key).toEqual({
        id: expect.any(String),
        userId: b.user.id,
        name: "terminal",
        scope: "write",
        projectIds: [own.id],
        createdAt: b.now.value,
        expiresAt: b.now.value + 30 * DAY_MS,
        lastUsedAt: null,
      });
      const stored = b.db.query("select * from access_keys").get();
      expect(stored).toMatchObject({ token_hash: sha256(token) });
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(b.keys.byTokenHash(sha256(token))).toEqual(key);
      expect(b.keys.byTokenHash(sha256("unknown"))).toBeNull();
      const start = b.now.value;
      b.principal(token);
      expect(b.keys.byId(key.id)!.lastUsedAt).toBe(start);
      const changes = () =>
        b.db.query<{ n: number }, []>("select total_changes() as n").get()!.n;
      const written = changes();
      b.now.value += MINUTE_MS - 1;
      b.principal(token);
      b.keys.touch(key.id, b.now.value);
      expect(b.keys.byId(key.id)!.lastUsedAt).toBe(start);
      expect(changes()).toBe(written);
      b.now.value++;
      b.principal(token);
      expect(b.keys.byId(key.id)!.lastUsedAt).toBe(b.now.value);
      expect(changes()).toBe(written + 1);
      expect(b.keys.byId(key.id)!.expiresAt).toBe(key.expiresAt);
      expect(b.keys.delete("other", key.id)).toBeNull();
      expect(b.keys.deleteForUser(b.user.id)).toHaveLength(1);
      expect(b.keys.list(b.user.id)).toEqual([]);
    } finally {
      b.db.close();
    }
  });
});

describe("the key policy", () => {
  for (const method of ["GET", "POST"]) {
    test(`${method} reads only a valid bearer, never a cookie, and does not advertise OAuth`, async () => {
      const b = build();
      try {
        const { token, key } = b.make();
        const cookie = b.access.open(b.user).setCookie.split(";")[0]!;
        for (const authorization of [
          "",
          "Bearer",
          "Basic anything",
          "Bearer bad",
          `Bearer ${token} extra`,
          `Bearer ${token}, Bearer ${token}`,
          `Bearer 1ctx_${"a".repeat(43)}`,
        ]) {
          const res = await b.call({ authorization, cookie }, method);
          expect(res.status).toBe(401);
          expect(res.headers.has("www-authenticate")).toBe(false);
          expect(res.headers.has("set-cookie")).toBe(false);
          expect(await res.json()).toEqual({ error: "sign in" });
        }
        expect((await b.call({ cookie }, method)).status).toBe(401);
        const good = await b.call(
          { authorization: `bEaReR ${token}`, cookie: "login=bad" },
          method,
        );
        expect(good.status).toBe(200);
        expect((await good.json()).via).toEqual({
          kind: "key",
          id: key.id,
          name: key.name,
          scope: key.scope,
          projectIds: null,
        });
        expect(good.headers.has("set-cookie")).toBe(false);
        b.now.value = key.expiresAt;
        expect(
          (await b.call({ authorization: `Bearer ${token}` }, method)).status,
        ).toBe(401);
        expect(b.keys.byId(key.id)).not.toBeNull();
        b.now.value--;
        b.keys.delete(b.user.id, key.id);
        expect(
          (await b.call({ authorization: `Bearer ${token}` }, method)).status,
        ).toBe(401);
      } finally {
        b.db.close();
      }
    });

    test(`${method} checks exact Origin but a terminal needs none, even with fetch metadata`, async () => {
      const b = build();
      try {
        const { token } = b.make();
        const headers = { authorization: `Bearer ${token}` };
        for (const origin of ["http://app.test", undefined]) {
          for (const site of ["same-origin", "cross-site"]) {
            expect(
              (
                await b.call(
                  {
                    ...headers,
                    "sec-fetch-site": site,
                    ...(origin === undefined ? {} : { origin }),
                  },
                  method,
                )
              ).status,
            ).toBe(200);
          }
        }
        for (const origin of [
          "http://other.test",
          "https://app.test",
          "null",
          "bad",
          "http://app.test/path",
          "http://app.test:1234",
        ]) {
          expect((await b.call({ ...headers, origin }, method)).status).toBe(
            403,
          );
        }
        const forwarded = {
          ...headers,
          origin: "https://app.test",
          "x-forwarded-proto": "http, https",
        };
        expect((await b.call(forwarded, method, true)).status).toBe(200);
        expect((await b.call(forwarded, method, false)).status).toBe(403);
        expect(
          (
            await b.call(
              { ...forwarded, origin: "http://app.test" },
              method,
              true,
            )
          ).status,
        ).toBe(403);
      } finally {
        b.db.close();
      }
    });
  }

  test("preserves the cookie Origin rule", () => {
    const url = new URL("http://app.test/api/x");
    expect(sameOrigin(new Request(url, { method: "POST" }), url, false)).toBe(
      true,
    );
    expect(
      sameOrigin(
        new Request(url, {
          method: "POST",
          headers: { "sec-fetch-site": "same-origin" },
        }),
        url,
        false,
      ),
    ).toBe(false);
    expect(
      sameOrigin(
        new Request(url, {
          method: "POST",
          headers: { origin: "https://app.test" },
        }),
        url,
        false,
      ),
    ).toBe(true);
  });

  test("reads the cap before credentials and Origin, keeps rows and recovers when raised", async () => {
    const b = build();
    try {
      const { key, token } = b.make();
      b.cap.value = 0;
      for (const method of ["GET", "POST"]) {
        for (const authorization of ["", "Bearer bad", `Bearer ${token}`]) {
          expect(
            (
              await b.call(
                { authorization, origin: "http://other.test" },
                method,
              )
            ).status,
          ).toBe(404);
        }
      }
      expect(b.keys.byId(key.id)).toEqual(key);
      b.cap.value = 1;
      expect((await b.call({ authorization: `Bearer ${token}` })).status).toBe(
        200,
      );
    } finally {
      b.db.close();
    }
  });

  test("refuses disabled users and must-change users and logs no token", async () => {
    const b = build();
    try {
      const { token } = b.make();
      const headers = { authorization: `Bearer ${token}` };
      b.users.setMustChangePassword(b.user.id, true);
      expect((await b.call(headers)).status).toBe(403);
      b.users.setMustChangePassword(b.user.id, false);
      b.users.setDisabled(b.user.id, true);
      expect((await b.call(headers)).status).toBe(401);
      b.users.setDisabled(b.user.id, false);
      expect((await b.call(headers)).status).toBe(200);
      expect(b.logs.events.filter((e) => e.msg === "request")).toHaveLength(1);
      expect(b.logs.events.at(-1)!.fields.user).toBe("casey");
      expect(JSON.stringify(b.logs.events)).not.toContain(token);
    } finally {
      b.db.close();
    }
  });
});

describe("key visibility and in-transaction checks", () => {
  test("intersects picks with current membership and role, for one project and for lists", () => {
    const b = build();
    try {
      const own = b.projects.personal(b.user.id)!;
      const team = b.projects.createTeam({
        ownerId: b.user.id,
        name: "team",
        description: "",
        now: b.now.value,
      });
      b.projects.addMember(team.id, b.user.id, b.now.value);
      const other = b.users.createUser({
        username: "other",
        fullName: "Other",
        email: "other@example.test",
        role: "member",
        passwordHash: "unused",
        mustChangePassword: false,
        now: b.now.value,
      });
      const key = b.principal(b.make([team.id]).token);
      expect(b.access.project(key, team.id).id).toBe(team.id);
      expect(b.access.reachableProjectIds(key)).toEqual([team.id]);
      for (const id of [own.id, "missing", b.projects.personal(other.id)!.id]) {
        expect(() => b.access.project(key, id)).toThrow(
          new NotFound("no such project"),
        );
      }
      b.projects.removeMember(team.id, b.user.id);
      expect(() => b.access.project(key, team.id)).toThrow(
        new NotFound("no such project"),
      );
      expect(b.access.reachableProjectIds(key)).toEqual([]);
      b.users.setRole(b.user.id, "admin");
      expect(b.access.project(key, team.id).id).toBe(team.id);
      expect(b.access.reachableProjectIds(key)).toEqual([team.id]);
      expect(() => b.access.project(key, own.id)).toThrow(NotFound);
      b.keys.deleteForUser(b.user.id);
      const all = b.principal(b.make().token);
      expect(b.access.reachableProjectIds(all).sort()).toEqual(
        [own.id, team.id].sort(),
      );
      expect(() =>
        b.access.project(all, b.projects.personal(other.id)!.id),
      ).toThrow(NotFound);
      b.users.setRole(b.user.id, "member");
      expect(() => b.access.project(all, team.id)).toThrow(NotFound);
      expect(b.access.reachableProjectIds(all)).toEqual([own.id]);
    } finally {
      b.db.close();
    }
  });

  for (const change of [
    "revoke",
    "expire",
    "disable",
    "must-change",
    "project",
  ] as const) {
    test(`checkKey refuses ${change} after resolution and rolls a write back`, () => {
      const b = build();
      try {
        const { key, token } = b.make();
        const principal = b.principal(token);
        const own = b.projects.personal(b.user.id)!.id;
        expect(() => b.access.checkKey(principal, own)).not.toThrow();
        if (change === "revoke") b.keys.delete(b.user.id, key.id);
        if (change === "expire") b.now.value = key.expiresAt;
        if (change === "disable") b.users.setDisabled(b.user.id, true);
        if (change === "must-change")
          b.users.setMustChangePassword(b.user.id, true);
        // a project the user does not see stands for one lost since
        const target =
          change === "project"
            ? b.projects.personal(
                b.users.createUser({
                  username: "other",
                  fullName: "Other",
                  email: "other@example.test",
                  role: "member",
                  passwordHash: "unused",
                  mustChangePassword: false,
                  now: b.now.value,
                }).id,
              )!.id
            : own;
        expect(() =>
          transact(b.db, () => {
            b.users.setDetails(b.user.id, { fullName: "Changed", about: "" });
            b.access.checkKey(principal, target);
            return { result: undefined };
          }),
        ).toThrow(
          change === "revoke" || change === "expire"
            ? Unauthorized
            : change === "project"
              ? NotFound
              : Forbidden,
        );
        expect(b.users.byId(b.user.id)!.fullName).toBe("Casey");
        expect(() =>
          b.access.checkKey(
            { ...principal, via: { kind: "login", id: "gone" } },
            target,
          ),
        ).not.toThrow();
      } finally {
        b.db.close();
      }
    });
  }

  test("a key revoked while a write body arrives is refused inside its transaction", async () => {
    const b = build();
    try {
      const { key, token } = b.make();
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const handle = b.handle(false, [
        {
          method: "POST",
          path: "/key-test",
          policy: "key",
          async handle(req, ctx) {
            entered();
            await jsonBody(req);
            transact(b.db, () => {
              b.access.checkKey(
                ctx.principal!,
                b.projects.personal(b.user.id)!.id,
              );
              b.users.setDetails(b.user.id, { fullName: "Changed", about: "" });
              return { result: undefined };
            });
            return json({ ok: true });
          },
        },
      ]);
      const response = handle(
        new Request("http://app.test/key-test", {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
          }),
        }),
        "127.0.0.1",
      );
      await reading;
      b.keys.delete(b.user.id, key.id);
      body.enqueue(new TextEncoder().encode("{}"));
      body.close();
      expect((await response)!.status).toBe(401);
      expect(b.users.byId(b.user.id)!.fullName).toBe("Casey");
    } finally {
      b.db.close();
    }
  });
});
