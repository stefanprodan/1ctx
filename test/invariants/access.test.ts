// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every route the binary composes, every caller, denials included; and
// every route present in the matrix.

import { describe, expect, test } from "bun:test";
import { hashPassword } from "../../src/server/users/index.ts";
import { testApp } from "../helpers/app.ts";
import { AUTH_CASES, type Caller } from "../helpers/auth-cases.ts";

describe("the authorization matrix", () => {
  test("covers every composed route", async () => {
    const app = await testApp();
    for (const route of app.routes) {
      const covered = AUTH_CASES.some(
        (c) => c.method === route.method && c.path === route.path,
      );
      expect(covered, `${route.method} ${route.path} has no auth case`).toBe(
        true,
      );
    }
    for (const c of AUTH_CASES) {
      const exists = app.routes.some(
        (r) => r.method === c.method && r.path === c.path,
      );
      expect(exists, `${c.method} ${c.path} is not a route`).toBe(true);
    }
  });

  for (const c of AUTH_CASES) {
    for (const caller of Object.keys(c.expect) as Caller[]) {
      test(`${c.method} ${c.path} as ${caller} is ${c.expect[caller]}`, async () => {
        const app = await testApp();
        app.createUser({
          username: "oana",
          fullName: "Oana",
          role: "member",
          passwordHash: await hashPassword("pw"),
          now: app.now.value,
        });
        const client = app.client();
        if (caller === "admin")
          expect((await client.login("admin", "hunter2-test")).status).toBe(
            200,
          );
        if (caller === "member")
          expect((await client.login("oana", "pw")).status).toBe(200);
        const res = await client.call(c.method, c.path, { body: c.body });
        expect(res.status).toBe(c.expect[caller]);
      });
    }
  }
});
