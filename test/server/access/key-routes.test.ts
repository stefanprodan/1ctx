// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DAY_MS } from "../../../src/server/lib/clock.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import type { AccessKeysResponse } from "../../../src/shared/api/profile.ts";
import { createKey, KEY_REQUEST } from "../../helpers/access-keys.ts";
import {
  collectLogs,
  hashPassword,
  ORIGIN,
  testApp,
} from "../../helpers/app.ts";
import { emailApp, MARIA_PASSWORD } from "../../helpers/links.ts";

async function setup() {
  const logs = collectLogs();
  const app = await testApp({ logFactory: logs.logFactory });
  const admin = app.client();
  expect((await admin.login("admin", "hunter2-test")).status).toBe(200);
  const user = app.createUser({
    username: "casey",
    fullName: "Casey",
    email: "casey@example.test",
    role: "member",
    passwordHash: await hashPassword("longenough"),
    mustChangePassword: false,
    now: app.now.value,
  });
  const client = app.client();
  expect((await client.login("casey", "longenough")).status).toBe(200);
  const list = async (): Promise<AccessKeysResponse> => {
    const res = await client.call("GET", "/api/profile/keys");
    expect(res.status).toBe(200);
    return res.json();
  };
  const cap = async (value: number) => {
    const res = await admin.call("PUT", "/api/limits", {
      body: { values: { ...DEFAULT_LIMITS, accessKeysPerUser: value } },
    });
    expect(res.status).toBe(200);
  };
  const stored = () =>
    app.db
      .query<{ id: string }, [string]>(
        "select id from access_keys where user_id = ? order by id",
      )
      .all(user.id);
  return { app, admin, user, client, list, cap, stored, logs };
}

describe("access key routes", () => {
  test("shows the token once, lists newest first and emits one safe creation or revocation log", async () => {
    const b = await setup();
    try {
      expect(await b.list()).toEqual({ keys: [], limit: 5 });
      const own = b.app.projects.personal(b.user.id)!;
      const first = await createKey(b.client, {
        name: "a",
        scope: "read",
        projectIds: [own.id],
        days: 90,
      });
      b.app.now.value++;
      const second = await createKey(b.client, {
        name: "b".repeat(64),
        days: 365,
      });
      expect(second.token).not.toBe(first.token);
      expect(first.key.expiresAt - first.key.createdAt).toBe(90 * DAY_MS);
      expect(second.key.expiresAt - second.key.createdAt).toBe(365 * DAY_MS);
      expect(first.key.lastUsedAt).toBeNull();
      expect(Object.keys(first).sort()).toEqual(["key", "token"]);
      expect(Object.keys(first.key).sort()).toEqual([
        "createdAt",
        "expiresAt",
        "id",
        "lastUsedAt",
        "name",
        "projectIds",
        "scope",
      ]);
      const listed = await b.list();
      expect(listed).toEqual({ keys: [second.key, first.key], limit: 5 });
      const adminList = await b.admin.call(
        "GET",
        `/api/users/${b.user.id}/keys`,
      );
      expect(await adminList.json()).toEqual({ keys: listed.keys });
      expect(JSON.stringify(listed)).not.toContain(first.token);
      expect(JSON.stringify(listed)).not.toContain("tokenHash");
      const sameName = await b.client.call("POST", "/api/profile/keys", {
        body: { ...KEY_REQUEST, name: "a" },
      });
      expect(sameName.status).toBe(409);
      expect(await sameName.json()).toEqual({
        error: "access key name is taken",
      });
      expect(
        (await b.client.call("DELETE", `/api/profile/keys/${first.key.id}`))
          .status,
      ).toBe(204);
      expect(
        (await b.client.call("DELETE", `/api/profile/keys/${first.key.id}`))
          .status,
      ).toBe(404);
      expect(
        (
          await b.admin.call(
            "DELETE",
            `/api/users/${b.user.id}/keys/${second.key.id}`,
          )
        ).status,
      ).toBe(204);
      expect(await b.list()).toEqual({ keys: [], limit: 5 });
      const records = b.logs.events.filter((event) =>
        event.msg.startsWith("access key "),
      );
      expect(
        records.map((event) => ({ msg: event.msg, fields: event.fields })),
      ).toEqual([
        {
          msg: "access key created",
          fields: { user: "casey", key: first.key.id, scope: "read" },
        },
        {
          msg: "access key created",
          fields: { user: "casey", key: second.key.id, scope: "write" },
        },
        {
          msg: "access key revoked",
          fields: { user: "casey", key: first.key.id, scope: "read" },
        },
        {
          msg: "access key revoked",
          fields: { user: "casey", key: second.key.id, scope: "write" },
        },
      ]);
      expect(JSON.stringify(b.logs.events)).not.toContain(first.token);
      expect(JSON.stringify(b.logs.events)).not.toContain(second.token);
      await createKey(b.client, { name: "a" });
    } finally {
      await b.app.shutdown();
    }
  });

  test("keeps owner boundaries and no admin route mints for another user", async () => {
    const b = await setup();
    try {
      const member = await createKey(b.client);
      const admin = await createKey(b.admin);
      expect((await b.list()).keys).toEqual([member.key]);
      expect(
        (await b.client.call("DELETE", `/api/profile/keys/${admin.key.id}`))
          .status,
      ).toBe(404);
      expect(
        (await b.client.call("GET", `/api/users/${b.user.id}/keys`)).status,
      ).toBe(403);
      expect(
        (
          await b.client.call(
            "DELETE",
            `/api/users/${b.user.id}/keys/${member.key.id}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await b.admin.call(
            "DELETE",
            `/api/users/${b.user.id}/keys/${admin.key.id}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (await b.admin.call("GET", "/api/users/missing/keys")).status,
      ).toBe(404);
      expect(
        (
          await b.admin.call("POST", `/api/users/${b.user.id}/keys`, {
            body: KEY_REQUEST,
          })
        ).status,
      ).toBe(405);
      expect(
        (
          await b.admin.call(
            "DELETE",
            `/api/users/missing/keys/${member.key.id}`,
          )
        ).status,
      ).toBe(404);
      expect((await b.list()).keys).toEqual([member.key]);
    } finally {
      await b.app.shutdown();
    }
  });

  for (const body of [
    null,
    [],
    {},
    ...["", "x".repeat(65), " leading", "trailing ", "two\nlines", 7].map(
      (name) => ({ ...KEY_REQUEST, name }),
    ),
    ...["admin", null, 1].map((scope) => ({ ...KEY_REQUEST, scope })),
    ...[0, 31, 30.5, "30", null].map((days) => ({ ...KEY_REQUEST, days })),
    ...[[], ["id", "id"], [1], [null], "id", ["a/b"]].map((projectIds) => ({
      ...KEY_REQUEST,
      projectIds,
    })),
    { ...KEY_REQUEST, userId: "another" },
    { ...KEY_REQUEST, extra: true },
  ]) {
    test(`rejects an invalid create body ${JSON.stringify(body)}`, async () => {
      const b = await setup();
      try {
        const res = await b.client.call("POST", "/api/profile/keys", { body });
        expect(res.status).toBe(400);
        expect(b.stored()).toEqual([]);
        expect(b.logs.events.some((e) => e.msg === "access key created")).toBe(
          false,
        );
      } finally {
        await b.app.shutdown();
      }
    });
  }

  test("requires every create field and a visible project, with no partial key", async () => {
    const b = await setup();
    try {
      for (const field of Object.keys(KEY_REQUEST)) {
        const body = Object.fromEntries(
          Object.entries(KEY_REQUEST).filter(([name]) => name !== field),
        );
        expect(
          (await b.client.call("POST", "/api/profile/keys", { body })).status,
        ).toBe(400);
      }
      const team = b.app.projects.createTeam({
        ownerId: b.user.id,
        name: "team",
        description: "",
        now: b.app.now.value,
      });
      const own = b.app.projects.personal(b.user.id)!;
      const adminOwn = b.app.projects.personal(
        b.app.users.byUsername("admin")!.id,
      )!;
      for (const id of ["missing", team.id, adminOwn.id]) {
        const res = await b.client.call("POST", "/api/profile/keys", {
          body: { ...KEY_REQUEST, projectIds: [own.id, id] },
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "no such project" });
      }
      expect(b.stored()).toEqual([]);
      b.app.projects.addMember(team.id, b.user.id, b.app.now.value);
      expect(
        (await createKey(b.client, { projectIds: [own.id, team.id] })).key
          .projectIds,
      ).toEqual([own.id, team.id]);
      expect(
        (await createKey(b.admin, { projectIds: [team.id] })).key.projectIds,
      ).toEqual([team.id]);
      expect(
        (
          await b.admin.call("POST", "/api/profile/keys", {
            body: { ...KEY_REQUEST, name: "private", projectIds: [own.id] },
          })
        ).status,
      ).toBe(404);
    } finally {
      await b.app.shutdown();
    }
  });

  test("reads the cap on creation and list, retains expired keys, and never deletes on lowering", async () => {
    const b = await setup();
    try {
      await b.cap(2);
      const first = await createKey(b.client);
      const second = await createKey(b.client, { name: "second" });
      const extra = () =>
        b.client.call("POST", "/api/profile/keys", {
          body: { ...KEY_REQUEST, name: "extra" },
        });
      expect((await extra()).status).toBe(409);
      b.app.db
        .query("update access_keys set expires_at = ? where id = ?")
        .run(b.app.now.value, first.key.id);
      expect((await extra()).status).toBe(409);
      await b.cap(0);
      expect((await b.list()).limit).toBe(0);
      const off = await extra();
      expect(off.status).toBe(409);
      expect(await off.json()).toEqual({ error: "access keys are off" });
      expect(b.stored()).toHaveLength(2);
      expect(
        (await b.client.call("DELETE", `/api/profile/keys/${first.key.id}`))
          .status,
      ).toBe(204);
      await b.cap(1);
      expect((await extra()).status).toBe(409);
      expect((await b.list()).keys).toEqual([second.key]);
      await b.cap(2);
      await createKey(b.client, { name: "extra" });
    } finally {
      await b.app.shutdown();
    }
  });

  test("two creates race for one remaining place, and for one name", async () => {
    const b = await setup();
    try {
      await b.cap(1);
      const responses = await Promise.all(
        ["one", "two"].map((name) =>
          b.client.call("POST", "/api/profile/keys", {
            body: { ...KEY_REQUEST, name },
          }),
        ),
      );
      expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(b.stored()).toHaveLength(1);
      await b.cap(5);
      const duplicates = await Promise.all(
        [0, 1].map(() =>
          b.client.call("POST", "/api/profile/keys", {
            body: { ...KEY_REQUEST, name: "same" },
          }),
        ),
      );
      expect(duplicates.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(b.stored()).toHaveLength(2);
    } finally {
      await b.app.shutdown();
    }
  });

  test("a must-change login cannot list, create or revoke keys", async () => {
    const b = await setup();
    try {
      const { key } = await createKey(b.client);
      b.app.users.setMustChangePassword(b.user.id, true);
      for (const [method, path] of [
        ["GET", "/api/profile/keys"],
        ["POST", "/api/profile/keys"],
        ["DELETE", `/api/profile/keys/${key.id}`],
      ]) {
        expect(
          (
            await b.client.call(method!, path!, {
              body: method === "POST" ? KEY_REQUEST : undefined,
            })
          ).status,
        ).toBe(403);
      }
      expect(b.stored()).toHaveLength(1);
    } finally {
      await b.app.shutdown();
    }
  });

  test("a reset while the create body arrives cannot leave a new key", async () => {
    const b = await setup();
    try {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const response = b.app.handle(
        new Request(`${ORIGIN}/api/profile/keys`, {
          method: "POST",
          headers: { cookie: b.client.cookie!, origin: ORIGIN },
          body: new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
        }),
        "127.0.0.1",
      );
      const reset = await b.admin.call(
        "POST",
        `/api/users/${b.user.id}/password`,
        {
          body: { password: "reset-password" },
        },
      );
      expect(reset.status).toBe(204);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(KEY_REQUEST)));
      controller.close();
      expect((await response)!.status).toBe(401);
      expect(b.stored()).toEqual([]);
    } finally {
      await b.app.shutdown();
    }
  });
});

describe("the ends of access keys", () => {
  for (const ending of ["disable", "admin reset", "own password"] as const) {
    test(`${ending} removes only the credentials it should`, async () => {
      const b = await setup();
      try {
        const { key, token } = await createKey(b.client);
        const adminKey = await createKey(b.admin);
        const oldLogin = b.app.client();
        expect((await oldLogin.login("casey", "longenough")).status).toBe(200);
        const response =
          ending === "disable"
            ? await b.admin.call("PATCH", `/api/users/${b.user.id}`, {
                body: { disabled: true },
              })
            : ending === "admin reset"
              ? await b.admin.call("POST", `/api/users/${b.user.id}/password`, {
                  body: { password: "reset-password" },
                })
              : await b.client.call("POST", "/api/profile/password", {
                  body: { current: "longenough", next: "changed-password" },
                });
        expect(response.status).toBe(ending === "admin reset" ? 204 : 200);
        expect(b.stored()).toEqual(
          ending === "own password" ? [{ id: key.id }] : [],
        );
        expect(
          (await (await oldLogin.call("GET", "/api/me")).json()).user,
        ).toBeNull();
        expect(
          b.app.db
            .query("select id from access_keys where id = ?")
            .get(adminKey.key.id),
        ).not.toBeNull();
        expect(
          b.logs.events.filter((e) => e.msg === "access key revoked"),
        ).toHaveLength(ending === "own password" ? 0 : 1);
        expect(JSON.stringify(b.logs.events)).not.toContain(token);
        if (ending === "disable") {
          expect(
            (
              await b.admin.call("PATCH", `/api/users/${b.user.id}`, {
                body: { disabled: false },
              })
            ).status,
          ).toBe(200);
          expect(b.stored()).toEqual([]);
        }
      } finally {
        await b.app.shutdown();
      }
    });
  }

  for (const purpose of ["reset", "invite", "signin"] as const) {
    test(`${purpose} link use ends keys only when it sets a password`, async () => {
      const e = await emailApp();
      try {
        const tab = e.app.client();
        expect((await tab.login("maria", MARIA_PASSWORD)).status).toBe(200);
        const { key, token } = await createKey(tab);
        if (purpose === "invite")
          e.app.users.setMustChangePassword(e.maria.id, true);
        const requested =
          purpose === "signin"
            ? await e.app.client().call("POST", "/api/login/link", {
                body: { username: "maria" },
              })
            : await e.admin.call(
                "POST",
                `/api/users/${e.maria.id}/${purpose === "reset" ? "reset-link" : "invite"}`,
              );
        expect(requested.status).toBe(purpose === "signin" ? 202 : 204);
        await e.app.linkAsks();
        await e.send();
        const link = e.token();
        const row = () =>
          e.app.db.query("select id from access_keys where id = ?").get(key.id);
        expect(row()).not.toBeNull();
        const used = await e.app.client().call("POST", `/api/links/${link}`, {
          body: purpose === "signin" ? {} : { password: "new-password" },
        });
        expect(used.status).toBe(200);
        expect(row()).toEqual(purpose === "signin" ? { id: key.id } : null);
        const old = (await (await tab.call("GET", "/api/me")).json()).user;
        expect(old?.username ?? null).toBe(
          purpose === "signin" ? "maria" : null,
        );
        expect(
          e.logs.events.filter((event) => event.msg === "access key revoked"),
        ).toHaveLength(purpose === "signin" ? 0 : 1);
        expect(JSON.stringify(e.logs.events)).not.toContain(token);
      } finally {
        await e.app.shutdown();
      }
    });
  }

  test("a failed reset rolls keys and logins back and emits no revocation log", async () => {
    const b = await setup();
    try {
      const { key } = await createKey(b.client);
      b.app.db.exec(`create trigger refuse_key_delete before delete on access_keys
        begin select raise(abort, 'test refusal'); end`);
      const reset = await b.admin.call(
        "POST",
        `/api/users/${b.user.id}/password`,
        {
          body: { password: "reset-password" },
        },
      );
      expect(reset.status).toBe(500);
      expect(b.stored()).toEqual([{ id: key.id }]);
      expect(
        (await (await b.client.call("GET", "/api/me")).json()).user.username,
      ).toBe("casey");
      expect(b.app.users.byId(b.user.id)!.mustChangePassword).toBe(false);
      expect(
        b.logs.events.filter((e) => e.msg === "access key revoked"),
      ).toEqual([]);
    } finally {
      await b.app.shutdown();
    }
  });
});
