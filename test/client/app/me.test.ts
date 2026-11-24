// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user survives a first load that answers late: the
// page asks who is signed in, the person signs in before the answer
// comes, and the answer, "nobody", must not undo the sign-in. A sign-in
// leaves the card only once GET /api/me names the user.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  dictationOn,
  emailOn,
  loadMe,
  login,
  logout,
  me,
  meError,
  readMeAnswer,
} from "../../../src/client/data/me.ts";
import { settle } from "../../helpers/async.ts";

const casey = {
  id: "u1",
  username: "casey",
  fullName: "Casey",
  role: "member" as const,
};
const flags = { emailOn: true, dictationOn: false };

describe("an answer of GET /api/me", () => {
  test("is read only when it names a user or nobody, flags and all", () => {
    expect(readMeAnswer({ user: null, ...flags })).toEqual({
      user: null,
      ...flags,
    });
    expect(
      readMeAnswer({ user: casey, emailOn: true, dictationOn: true }),
    ).toEqual({ user: casey, emailOn: true, dictationOn: true });
    expect(readMeAnswer({})).toBeNull();
    expect(readMeAnswer(null)).toBeNull();
    expect(readMeAnswer({ user: null })).toBeNull();
    expect(
      readMeAnswer({ user: null, emailOn: "yes", dictationOn: false }),
    ).toBeNull();
    expect(readMeAnswer({ user: { id: "u1" }, ...flags })).toBeNull();
    expect(
      readMeAnswer({ user: { ...casey, role: "owner" }, ...flags }),
    ).toBeNull();
  });
});

describe("me", () => {
  const realFetch = globalThis.fetch;
  // each GET /api/me waits for the test to answer it, with a body or a
  // whole response
  let held: ((answer: unknown) => void)[] = [];
  let calls: string[] = [];

  beforeEach(() => {
    me.value = undefined;
    held = [];
    calls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "GET" && url === "/api/me") {
        const answer = await new Promise<unknown>((r) => held.push(r));
        return answer instanceof Response ? answer : Response.json(answer);
      }
      if (method === "POST" && url === "/api/login") {
        const key = JSON.parse(String(init?.body)).key;
        if (key === "wrong") {
          return Response.json({ error: "anything" }, { status: 401 });
        }
        return Response.json({ user: casey });
      }
      if (method === "POST" && url === "/api/logout") {
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    me.value = undefined;
    meError.value = null;
    dictationOn.value = false;
    emailOn.value = false;
  });

  test.serial("a malformed answer is a failure, never nobody", async () => {
    const load = loadMe();
    await settle();
    held.shift()?.({ user: "casey", ...flags });
    expect(await load).toBe("failed");
    expect(me.value).toBeUndefined();
    expect(meError.value?.words).toBe("the server failed");
  });

  test.serial("a flag that is no boolean keeps the flags held", async () => {
    emailOn.value = true;
    dictationOn.value = true;
    const load = loadMe();
    await settle();
    held.shift()?.({ user: casey, emailOn: 1, dictationOn: false });
    expect(await load).toBe("failed");
    expect(emailOn.value).toBe(true);
    expect(dictationOn.value).toBe(true);
    expect(me.value).toBeUndefined();
  });

  test.serial("a key sign-in leaves only once me names the user", async () => {
    const signing = login({ key: "k" });
    await settle();
    expect(calls).toEqual(["POST /api/login", "GET /api/me"]);
    expect(me.value).toBeUndefined();
    held.shift()?.({ user: casey, emailOn: true, dictationOn: true });
    await signing;
    expect(me.value).toEqual(casey);
    expect(dictationOn.value).toBe(true);
    expect(emailOn.value).toBe(true);
  });

  test.serial("a read naming nobody after the key is no sign-in", async () => {
    const signing = login({ key: "k" }).then(
      () => "in",
      (err: Error) => err.message,
    );
    await settle();
    held.shift()?.({ user: null, ...flags });
    expect(await signing).toBe("not signed in");
    expect(me.value).toBeNull();
  });

  test.serial(
    "a failed read after the key is the card's, not the page's",
    async () => {
      const signing = login({ key: "k" }).then(
        () => "in",
        (err: Error) => err.message,
      );
      await settle();
      held.shift()?.(new Response("<html>", { status: 502 }));
      expect(await signing).toBe("the server failed");
      expect(meError.value).toBeNull();
    },
  );

  test.serial("a wrong key never signs anyone out", async () => {
    me.value = casey;
    const said = await login({ key: "wrong" }).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(said).toBe("wrong admin key");
    expect(me.value).toEqual(casey);
  });

  test.serial(
    "a superseded read's 401 never signs out a newer sign-in",
    async () => {
      const first = loadMe();
      const signing = login({ key: "k" });
      await settle();
      held[1]?.({ user: casey, ...flags });
      await signing;
      expect(me.value).toEqual(casey);
      held[0]?.(Response.json({ error: "signed out" }, { status: 401 }));
      await first;
      expect(me.value).toEqual(casey);
    },
  );

  test.serial("a current read's 401 signs out", async () => {
    me.value = casey;
    const load = loadMe();
    await settle();
    held.shift()?.(Response.json({ error: "signed out" }, { status: 401 }));
    expect(await load).toBe("nobody");
    expect(me.value).toBeNull();
  });

  test.serial("a late first load does not undo a sign-in", async () => {
    const first = loadMe();
    const signing = login({ key: "k" });
    await settle();
    // the sign-in's own read answers first, the page's first one after
    held[1]?.({ user: casey, ...flags });
    await signing;
    expect(me.value).toEqual(casey);
    held[0]?.({ user: null, ...flags });
    await first;
    expect(me.value).toEqual(casey);
  });

  test.serial("a late load does not undo a sign-out", async () => {
    me.value = casey;
    const late = loadMe();
    await logout();
    expect(me.value).toBeNull();
    await settle();
    held.shift()?.({ user: casey, ...flags });
    await late;
    expect(me.value).toBeNull();
  });

  test.serial("a sign-out hides Dictation", async () => {
    dictationOn.value = true;
    me.value = casey;
    await logout();
    expect(dictationOn.value).toBe(false);
  });

  test.serial("the latest of two loads wins", async () => {
    const first = loadMe();
    const second = loadMe();
    await settle();
    held[1]?.({ user: null, ...flags });
    await second;
    expect(me.value).toBeNull();
    held[0]?.({ user: casey, ...flags });
    expect(await first).toBe("nobody");
    expect(me.value).toBeNull();
  });
});
