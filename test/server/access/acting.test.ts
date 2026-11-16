// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin write that awaits its body reads the admin again in its
// transaction: what happened to the admin meanwhile stops the write.

import { expect, test } from "bun:test";
import { hashPassword, ORIGIN, testApp } from "../../helpers/app.ts";

const PASSWORD = "longenough";

async function setup() {
  const app = await testApp();
  const other = app.client();
  expect((await other.login("admin", "hunter2-test")).status).toBe(200);
  const make = async (username: string, role: "admin" | "member") =>
    app.createUser({
      username,
      fullName: username,
      email: `${username}@example.test`,
      role,
      passwordHash: await hashPassword(PASSWORD),
      mustChangePassword: false,
      now: app.now.value,
    });
  const acting = await make("ada", "admin");
  const casey = await make("casey", "member");
  const client = app.client();
  expect((await client.login("ada", PASSWORD)).status).toBe(200);
  const hashOf = (id: string) =>
    app.db
      .query<{ password_hash: string }, [string]>(
        "select password_hash from users where id = ?",
      )
      .get(id)!.password_hash;
  return { app, other, acting, casey, client, hashOf };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// the request goes through the router now, its body only when sent
function slowCall(b: Setup, method: string, path: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = b.app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { cookie: b.client.cookie!, origin: ORIGIN },
      body: new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
    }),
    "127.0.0.1",
  );
  return async (body: unknown) => {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
    controller.close();
    return (await response)!.status;
  };
}

const ENDINGS = {
  "sign-out": {
    status: 401,
    run: async (b: Setup) =>
      expect((await b.client.call("POST", "/api/logout")).status).toBeLessThan(
        300,
      ),
  },
  disable: {
    status: 401,
    run: async (b: Setup) =>
      expect(
        (
          await b.other.call("PATCH", `/api/users/${b.acting.id}`, {
            body: { disabled: true },
          })
        ).status,
      ).toBe(200),
  },
  demotion: {
    status: 403,
    run: async (b: Setup) =>
      expect(
        (
          await b.other.call("PATCH", `/api/users/${b.acting.id}`, {
            body: { role: "member" },
          })
        ).status,
      ).toBe(200),
  },
  reset: {
    status: 401,
    run: async (b: Setup) =>
      expect(
        (
          await b.other.call("POST", `/api/users/${b.acting.id}/password`, {
            body: { password: "reset-password" },
          })
        ).status,
      ).toBe(204),
  },
};

const WRITES = {
  create: {
    method: "POST",
    path: () => "/api/users",
    body: {
      username: "mallory",
      fullName: "Mallory",
      email: "mallory@example.test",
      role: "admin",
      tz: "UTC",
      password: PASSWORD,
    },
    unchanged: (b: Setup) =>
      expect(b.app.users.byUsername("mallory")).toBeNull(),
  },
  patch: {
    method: "PATCH",
    path: (b: Setup) => `/api/users/${b.casey.id}`,
    body: { role: "admin", email: "mallory@example.test" },
    unchanged: (b: Setup) => {
      const casey = b.app.users.byId(b.casey.id)!;
      expect(casey.role).toBe("member");
      expect(casey.email).toBe("casey@example.test");
    },
  },
  password: {
    method: "POST",
    path: (b: Setup) => `/api/users/${b.casey.id}/password`,
    body: { password: "mallory-knows" },
    unchanged: () => {},
  },
};

for (const [ending, end] of Object.entries(ENDINGS)) {
  for (const [name, write] of Object.entries(WRITES)) {
    test(`a ${ending} while the ${name} body arrives writes nothing`, async () => {
      const b = await setup();
      try {
        const hash = b.hashOf(b.casey.id);
        const send = slowCall(b, write.method, write.path(b));
        await end.run(b);
        expect(await send(write.body)).toBe(end.status);
        write.unchanged(b);
        expect(b.hashOf(b.casey.id)).toBe(hash);
        expect((await b.app.client().login("casey", PASSWORD)).status).toBe(
          200,
        );
      } finally {
        await b.app.shutdown();
      }
    });
  }
}

test("an admin still signed in finishes a slow write", async () => {
  const b = await setup();
  try {
    const send = slowCall(b, "PATCH", `/api/users/${b.casey.id}`);
    expect(await send({ fullName: "Casey Jones" })).toBe(200);
    expect(b.app.users.byId(b.casey.id)!.fullName).toBe("Casey Jones");
  } finally {
    await b.app.shutdown();
  }
});
