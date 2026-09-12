// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Every request parser refuses a malformed body and an unknown field.

import { describe, expect, test } from "bun:test";
import { parseLogin } from "../../src/server/access/parse.ts";
import { BadRequest } from "../../src/server/lib/errors.ts";
import { testApp } from "../helpers/app.ts";

describe("parseLogin", () => {
  test("accepts a name and a password", () => {
    expect(parseLogin({ name: "ana", password: "pw" })).toEqual({
      name: "ana",
      password: "pw",
    });
  });

  test.each([
    [null],
    ["string"],
    [[]],
    [{}],
    [{ name: "ana" }],
    [{ password: "pw" }],
    [{ name: "", password: "pw" }],
    [{ name: "ana", password: "" }],
    [{ name: 1, password: "pw" }],
    [{ name: "ana", password: { $ne: "" } }],
    [{ name: "ana", password: "pw", role: "admin" }],
    [{ name: "a".repeat(65), password: "pw" }],
    [{ name: "ana", password: "p".repeat(1025) }],
  ])("refuses %p", (body) => {
    expect(() => parseLogin(body)).toThrow(BadRequest);
  });
});

describe("over the wire", () => {
  test("a non-JSON body is a 400, not a crash", async () => {
    const app = await testApp();
    const res = await app.client().call("POST", "/api/login", {
      headers: { "content-type": "application/json" },
      body: undefined,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be JSON" });
  });

  test("an unknown field is a 400 with its name", async () => {
    const app = await testApp();
    const res = await app.client().call("POST", "/api/login", {
      body: { name: "admin", password: "hunter2", remember: true },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown field remember" });
  });

  test("an unknown path is 404 and a wrong method 405", async () => {
    const app = await testApp();
    expect((await app.client().call("GET", "/api/nothing")).status).toBe(404);
    expect((await app.client().call("DELETE", "/api/me")).status).toBe(405);
  });
});
