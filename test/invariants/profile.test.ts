// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The profile routes: the row, the full name and the zone, and email
// from agents.

import { describe, expect, test } from "bun:test";
import { testApp } from "../helpers/app.ts";
import { SMTP } from "../helpers/links.ts";

describe("GET /api/profile", () => {
  test("answers the signed-in user's row", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
    const res = await client.call("GET", "/api/profile");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        id: expect.any(String),
        username: "admin",
        fullName: "Administrator",
        email: "admin@1ctx.dev",
        tz: "UTC",
        about: "",
        role: "admin",
        createdAt: app.now.value,
        disabled: false,
        signedInAt: app.now.value,
        // the first admin's address is made up
        emailPlaceholder: true,
        emailFromAgents: false,
      },
      emailOn: false,
    });
  });
});

describe("PATCH /api/profile", () => {
  test("changes the full name, the about text and the zone, and me follows", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
    const res = await client.call("PATCH", "/api/profile", {
      body: {
        fullName: "Casey Doe",
        about: "Actor.",
        tz: "Europe/Bucharest",
      },
    });
    expect(res.status).toBe(200);
    const { user } = await res.json();
    expect(user.fullName).toBe("Casey Doe");
    expect(user.about).toBe("Actor.");
    expect(app.users.byUsername("admin")?.about).toBe("Actor.");
    expect(user.tz).toBe("Europe/Bucharest");
    expect(app.users.byUsername("admin")?.tz).toBe("Europe/Bucharest");
    const me = await (await client.call("GET", "/api/me")).json();
    expect(me.user.fullName).toBe("Casey Doe");
    expect(me.user.about).toBeUndefined();
    expect(me.user.username).toBe("admin");
  });

  test("refuses a bad name with a 400 and keeps the old one", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
    const res = await client.call("PATCH", "/api/profile", {
      body: { fullName: "  ", about: "", tz: "UTC" },
    });
    expect(res.status).toBe(400);
    expect(app.users.byUsername("admin")?.fullName).toBe("Administrator");
  });
});

describe("PUT /api/profile/email", () => {
  test("turns email from agents on and off, and says when email is on", async () => {
    const app = await testApp({ secrets: { "email-relay": "secret-pass" } });
    await app.email.stop();
    const client = app.client();
    await client.signIn("admin");
    const before = await (await client.call("GET", "/api/profile")).json();
    expect(before.emailOn).toBe(false);
    expect(before.user.emailFromAgents).toBe(false);

    expect(
      (await client.call("PUT", "/api/admin/smtp", { body: SMTP })).status,
    ).toBe(200);
    const on = await client.call("PUT", "/api/profile/email", {
      body: { fromAgents: true },
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      emailOn: true,
      user: { emailFromAgents: true },
    });
    const id = app.users.byUsername("admin")!.id;
    expect(app.users.byId(id)!.emailFromAgents).toBe(true);

    const off = await client.call("PUT", "/api/profile/email", {
      body: { fromAgents: false },
    });
    expect((await off.json()).user.emailFromAgents).toBe(false);
    expect(app.users.byId(id)!.emailFromAgents).toBe(false);
  });

  test("takes a boolean and nothing else", async () => {
    const app = await testApp();
    const client = app.client();
    await client.signIn("admin");
    for (const body of [
      {},
      { fromAgents: "yes" },
      { fromAgents: true, x: 1 },
    ]) {
      const res = await client.call("PUT", "/api/profile/email", { body });
      expect(res.status).toBe(400);
    }
  });
});
