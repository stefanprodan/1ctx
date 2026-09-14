// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user survives a first load that answers late: the
// page asks who is signed in, the person signs in before the answer
// comes, and the answer, "nobody", must not undo the sign-in.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadMe, login, logout, me } from "../../../src/client/data/me.ts";

const caelea = {
  id: "u1",
  username: "caelea",
  fullName: "Oana",
  role: "member" as const,
  mustChangePassword: false,
};

const realFetch = globalThis.fetch;
let gates: (() => void)[] = [];

beforeEach(() => {
  me.value = undefined;
  gates = [];
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/me") {
      // held until the test lets it go
      await new Promise<void>((r) => gates.push(r));
      return Response.json({ user: null });
    }
    if (url === "/api/login") return Response.json({ user: caelea });
    if (url === "/api/logout") return Response.json({ ok: true });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  me.value = undefined;
});

describe("me", () => {
  test("a late first load does not undo a sign-in", async () => {
    const first = loadMe();
    await login({ username: "caelea", password: "pw" });
    expect(me.value).toEqual(caelea);
    gates.shift()?.();
    await first;
    expect(me.value).toEqual(caelea);
  });

  test("a late load does not undo a sign-out either", async () => {
    await login({ username: "caelea", password: "pw" });
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/me") {
        await new Promise<void>((r) => gates.push(r));
        return Response.json({ user: caelea });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const late = loadMe();
    await logout();
    expect(me.value).toBeNull();
    gates.shift()?.();
    await late;
    expect(me.value).toBeNull();
  });

  test("the latest of two loads wins", async () => {
    const first = loadMe();
    const second = loadMe();
    gates[1]();
    await second;
    expect(me.value).toBeNull();
    me.value = caelea;
    gates[0]();
    await first;
    expect(me.value).toEqual(caelea);
  });
});
