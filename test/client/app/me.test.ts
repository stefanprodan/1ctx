// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user survives a first load that answers late: the
// page asks who is signed in, the person signs in before the answer
// comes, and the answer, "nobody", must not undo the sign-in.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  dictationOn,
  loadMe,
  login,
  logout,
  me,
} from "../../../src/client/data/me.ts";
import { settle } from "../../helpers/async.ts";

const casey = {
  id: "u1",
  username: "casey",
  fullName: "Casey",
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
    if (url === "/api/login") return Response.json({ user: casey });
    if (url === "/api/logout") return Response.json({ ok: true });
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  me.value = undefined;
  dictationOn.value = false;
});

describe("me", () => {
  test.serial("a late first load does not undo a sign-in", async () => {
    const first = loadMe();
    await login({ username: "casey", password: "pw" });
    expect(me.value).toEqual(casey);
    gates.shift()?.();
    await first;
    expect(me.value).toEqual(casey);
  });

  test.serial("a late load does not undo a sign-out either", async () => {
    await login({ username: "casey", password: "pw" });
    // the sign-in's own ask whether Dictation is on
    gates.shift()?.();
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/me") {
        await new Promise<void>((r) => gates.push(r));
        return Response.json({ user: casey });
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

  test.serial(
    "a sign-in asks whether Dictation is on, a sign-out hides it",
    async () => {
      globalThis.fetch = (async (url: string) => {
        if (url === "/api/me") {
          await new Promise<void>((r) => gates.push(r));
          return Response.json({
            user: casey,
            emailOn: false,
            dictationOn: true,
          });
        }
        if (url === "/api/login") return Response.json({ user: casey });
        return Response.json({ ok: true });
      }) as unknown as typeof fetch;
      await login({ username: "casey", password: "pw" });
      expect(dictationOn.value).toBe(false);
      gates.shift()?.();
      await settle();
      expect(dictationOn.value).toBe(true);
      await logout();
      expect(dictationOn.value).toBe(false);
    },
  );

  test.serial("the latest of two loads wins", async () => {
    const first = loadMe();
    const second = loadMe();
    gates[1]();
    await second;
    expect(me.value).toBeNull();
    me.value = casey;
    gates[0]();
    await first;
    expect(me.value).toEqual(casey);
  });
});
