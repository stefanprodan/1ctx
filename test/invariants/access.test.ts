// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every route the binary composes, every caller, denials included; and
// every route present in the matrix.

import { describe, expect, test } from "bun:test";
import { ADMIN_KEY, testApp } from "../helpers/app.ts";
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
      const by = c.bearer === undefined ? "" : ` with an ${c.bearer}`;
      test(`${c.method} ${c.path}${by} as ${caller} is ${c.expect[caller]}`, async () => {
        const app = await testApp();
        app.createUser({
          username: "casey",
          fullName: "Casey",
          email: "casey@example.com",
          role: "member",
          now: app.now.value,
        });
        const client = app.client();
        if (caller === "admin")
          expect((await client.signIn("admin")).status).toBe(200);
        if (caller === "member")
          expect((await client.signIn("casey")).status).toBe(200);
        const res = await client.call(c.method, c.path, {
          body: c.body,
          ...(c.bearer === undefined
            ? {}
            : { headers: { authorization: `Bearer ${ADMIN_KEY}` } }),
        });
        expect(res.status).toBe(c.expect[caller]);
      });
    }
  }
});
