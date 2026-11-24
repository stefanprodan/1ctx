// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An admin write that awaits its body reads the admin again in its
// transaction: what happened to the admin meanwhile stops the write.

import { expect, test } from "bun:test";
import { ORIGIN, testApp } from "../../helpers/app.ts";

const ADA_KEY = `1ctx-admin-${"a".repeat(43)}`;

async function setup() {
  const secrets: Record<string, string> = { "user-ada": ADA_KEY };
  const app = await testApp({ secrets });
  const other = app.client();
  expect((await other.signIn("admin")).status).toBe(200);
  const make = async (username: string, role: "admin" | "member") =>
    app.createUser({
      username,
      fullName: username,
      email: `${username}@example.test`,
      role,
      now: app.now.value,
    });
  const acting = await make("ada", "admin");
  const casey = await make("casey", "member");
  // by her key, so a rotation is one of the endings
  const client = app.client();
  const login = await client.call("POST", "/api/login", {
    body: { key: ADA_KEY },
  });
  expect(login.status).toBe(200);
  return { app, secrets, other, acting, casey, client };
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
  // a key login holds only while its user is an admin
  demotion: {
    status: 401,
    run: async (b: Setup) =>
      expect(
        (
          await b.other.call("PATCH", `/api/users/${b.acting.id}`, {
            body: { role: "member" },
          })
        ).status,
      ).toBe(200),
  },
  "sign out everywhere": {
    status: 401,
    run: async (b: Setup) =>
      expect(
        (await b.other.call("POST", `/api/users/${b.acting.id}/sign-out`))
          .status,
      ).toBe(204),
  },
  "key rotated": {
    status: 401,
    run: async (b: Setup) => {
      b.secrets["user-ada"] = `1ctx-admin-${"b".repeat(43)}`;
    },
  },
  "key file removed": {
    status: 401,
    run: async (b: Setup) => {
      delete b.secrets["user-ada"];
    },
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
  "access key": {
    method: "POST",
    path: () => "/api/profile/keys",
    body: { name: "laptop", scope: "write", projectIds: null, days: 30 },
    unchanged: (b: Setup) =>
      expect(
        b.app.db.query("select count(*) as n from access_keys").get(),
      ).toEqual({ n: 0 }),
  },
};

for (const [ending, end] of Object.entries(ENDINGS)) {
  for (const [name, write] of Object.entries(WRITES)) {
    test(`a ${ending} while the ${name} body arrives writes nothing`, async () => {
      const b = await setup();
      try {
        const send = slowCall(b, write.method, write.path(b));
        await end.run(b);
        expect(await send(write.body)).toBe(end.status);
        write.unchanged(b);
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
