// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The route table owns loading: a route's load runs when its path or
// query matches for a signed-in user, once per arrival, again on
// reload(), and never for nobody or for a member on an admin route.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reload, startLoading } from "../../../src/client/app/loading.ts";
import { path, query } from "../../../src/client/app/router.ts";
import type { Route } from "../../../src/client/app/routes.ts";
import { me } from "../../../src/client/data/me.ts";

const caelea = {
  id: "u1",
  username: "caelea",
  fullName: "Oana",
  role: "member" as const,
  mustChangePassword: false,
};

function table() {
  const calls: string[] = [];
  const base = {
    view: (() => null) as unknown as Route["view"],
    title: () => "x",
  };
  const routes: Route[] = [
    { ...base, path: "/", role: "authenticated" },
    {
      ...base,
      path: "/things/:id",
      role: "authenticated",
      load: async (params, q) => {
        calls.push(`thing ${params.id}${q.has("q") ? ` q=${q.get("q")}` : ""}`);
      },
    },
    {
      ...base,
      path: "/admin/x",
      role: "admin",
      load: async () => {
        calls.push("admin");
      },
    },
  ];
  return { routes, calls };
}

let stop: (() => void) | null = null;
const realFetch = globalThis.fetch;

// the rail's project list loads with every sign-in here; it gets an
// empty list and never leaves the test
beforeEach(() => {
  globalThis.fetch = (async () =>
    Response.json({ projects: [] })) as unknown as typeof fetch;
});

afterEach(async () => {
  stop?.();
  stop = null;
  me.value = undefined;
  path.value = "/";
  query.value = "";
  // let the rail's load settle before the fake goes
  await new Promise((r) => setTimeout(r, 0));
  globalThis.fetch = realFetch;
});

describe("startLoading", () => {
  test("runs the matched route's load for a signed-in user", () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/things/a";
    stop = startLoading(routes);
    expect(calls).toEqual(["thing a"]);
    path.value = "/things/b";
    expect(calls).toEqual(["thing a", "thing b"]);
  });

  test("loads nothing for nobody, then loads on sign-in", () => {
    const { routes, calls } = table();
    path.value = "/things/a";
    stop = startLoading(routes);
    expect(calls).toEqual([]);
    me.value = caelea;
    expect(calls).toEqual(["thing a"]);
  });

  test("the same user row replaced does not reload", () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/things/a";
    stop = startLoading(routes);
    me.value = { ...caelea, fullName: "Oana P" };
    expect(calls).toEqual(["thing a"]);
    me.value = { ...caelea, id: "u2" };
    expect(calls).toEqual(["thing a", "thing a"]);
  });

  test("a user who must change their password loads only the profile", () => {
    const { routes, calls } = table();
    routes.push({
      view: (() => null) as unknown as Route["view"],
      title: () => "x",
      path: "/profile",
      role: "authenticated",
      load: async () => {
        calls.push("profile");
      },
    });
    let projects = 0;
    globalThis.fetch = (async () => {
      projects++;
      return Response.json({ projects: [] });
    }) as unknown as typeof fetch;
    me.value = { ...caelea, mustChangePassword: true };
    path.value = "/things/a";
    stop = startLoading(routes);
    expect(calls).toEqual([]);
    expect(projects).toBe(0);
    path.value = "/profile";
    expect(calls).toEqual(["profile"]);
    // the change opens everything: the rail loads and the route again
    me.value = caelea;
    expect(projects).toBe(1);
    expect(calls).toEqual(["profile", "profile"]);
  });

  test("the same user promoted to admin loads the admin route", () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/admin/x";
    stop = startLoading(routes);
    expect(calls).toEqual([]);
    me.value = { ...caelea, role: "admin" };
    expect(calls).toEqual(["admin"]);
  });

  test("the same path twice loads once", () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/things/a";
    stop = startLoading(routes);
    path.value = "/things/a";
    expect(calls).toEqual(["thing a"]);
  });

  test("a load that throws is reported, not left unhandled", async () => {
    const { routes } = table();
    const failing: Route[] = [
      {
        ...routes[1],
        // a synchronous throw, the harder case: no promise to catch on
        load: () => {
          throw new Error("boom");
        },
      },
    ];
    const seen: string[] = [];
    const real = console.error;
    console.error = (line: string) => {
      seen.push(line);
    };
    try {
      me.value = caelea;
      path.value = "/things/a";
      stop = startLoading(failing);
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      console.error = real;
    }
    expect(seen).toEqual(["load for /things/:id failed: Error: boom"]);
  });

  test("a query change reloads with the query", () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/things/a";
    stop = startLoading(routes);
    query.value = "?q=pods";
    expect(calls).toEqual(["thing a", "thing a q=pods"]);
  });

  test("reload runs the current route's load again, or nothing", async () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/things/a";
    stop = startLoading(routes);
    await reload();
    expect(calls).toEqual(["thing a", "thing a"]);
    path.value = "/";
    await reload();
    expect(calls).toEqual(["thing a", "thing a"]);
    me.value = null;
    path.value = "/things/a";
    await reload();
    expect(calls).toEqual(["thing a", "thing a"]);
  });

  test("a disposed loader does not take the live one's reload", async () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/things/a";
    const first = startLoading(routes);
    stop = startLoading(routes);
    first();
    await reload();
    expect(calls).toEqual(["thing a", "thing a", "thing a"]);
  });

  test("a member on an admin route loads nothing; an admin does", () => {
    const { routes, calls } = table();
    me.value = caelea;
    path.value = "/admin/x";
    stop = startLoading(routes);
    expect(calls).toEqual([]);
    me.value = { ...caelea, id: "a1", role: "admin" };
    expect(calls).toEqual(["admin"]);
  });
});
