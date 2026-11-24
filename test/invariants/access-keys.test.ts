// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { createKey } from "../helpers/access-keys.ts";
import { testApp } from "../helpers/app.ts";
import { AUTH_CASES } from "../helpers/auth-cases.ts";

describe("a bearer has no authority on cookie routes", () => {
  for (const c of AUTH_CASES) {
    for (const caller of ["anonymous", "member", "admin"] as const) {
      test(`${c.method} ${c.path} with an admin bearer and ${caller} cookie`, async () => {
        const app = await testApp();
        try {
          app.createUser({
            username: "casey",
            fullName: "Casey",
            email: "casey@example.test",
            role: "member",
            now: app.now.value,
          });
          const admin = app.client();
          expect((await admin.signIn("admin")).status).toBe(200);
          const { token } = await createKey(admin);
          const client = app.client();
          if (caller === "member")
            expect((await client.signIn("casey")).status).toBe(200);
          if (caller === "admin")
            expect((await client.signIn("admin")).status).toBe(200);
          const route = app.routes.find(
            (r) => r.method === c.method && r.path === c.path,
          )!;
          // The endpoint has its own policy suite; this matrix isolates cookies.
          if (route.policy === "key") return;
          const res = await client.call(c.method, c.path, {
            body: c.body,
            headers: { authorization: `Bearer ${token}` },
          });
          expect(res.status).toBe(c.expect[caller]);
          if (c.path === "/api/me") {
            expect((await res.json()).user?.username ?? null).toBe(
              caller === "anonymous"
                ? null
                : caller === "member"
                  ? "casey"
                  : "admin",
            );
          }
        } finally {
          await app.shutdown();
        }
      });
    }
  }
});
