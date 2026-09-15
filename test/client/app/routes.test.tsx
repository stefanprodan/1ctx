// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The route table: every path matches itself and nothing else, every
// view renders, an admin route is out of a member's rail.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { App } from "../../../src/client/app/App.tsx";
import { path } from "../../../src/client/app/router.ts";
import {
  conflicts,
  match,
  navEntries,
  ROUTES,
} from "../../../src/client/app/routes.ts";
import { me } from "../../../src/client/data/me.ts";

describe("the route table", () => {
  test("every path matches itself and no other route", () => {
    for (const route of ROUTES) {
      const sample = route.path.replace(/:[a-z]+/g, "x1");
      const m = match(sample);
      expect(m?.route.path).toBe(route.path);
    }
    expect(match("/nothing/here")).toBeNull();
  });

  test("parameters are captured and decoded", () => {
    const routes = [{ ...ROUTES[0], path: "/things/:id" }];
    expect(match("/things/a%20b", routes)?.params).toEqual({ id: "a b" });
    expect(match("/things", routes)).toBeNull();
    expect(match("/things/a/b", routes)).toBeNull();
  });

  test("every view loads and renders against fixture state", async () => {
    me.value = {
      id: "u1",
      username: "caelea",
      fullName: "Oana",
      role: "member",
      mustChangePassword: false,
    };
    for (const route of ROUTES) {
      const View = route.view;
      await View.load();
      const html = render(<View params={{}} />);
      expect(html.length, `${route.path} rendered nothing`).toBeGreaterThan(0);
    }
  });

  test("a member's rail has no admin route", () => {
    const withAdmin = [
      ...ROUTES,
      {
        ...ROUTES[1],
        path: "/admin/x",
        role: "admin" as const,
        nav: { label: "X", icon: "settings" as const, order: 9 },
      },
    ];
    expect(navEntries("member", withAdmin).map((r) => r.path)).toEqual([
      "/",
      "/projects",
    ]);
    expect(navEntries("admin", withAdmin).map((r) => r.path)).toEqual([
      "/",
      "/projects",
      "/admin/projects",
      "/admin/users",
      "/admin/x",
      "/admin/agents",
      "/admin/tools",
      "/admin/skills",
      "/admin/mcp",
    ]);
  });

  test("every route has a title", () => {
    for (const route of ROUTES) expect(route.title({})).not.toBe("");
  });
});

describe("the route table's shape", () => {
  test("no route shadows another", () => {
    expect(conflicts()).toEqual([]);
    expect(
      conflicts([
        { ...ROUTES[0], path: "/things/:id" },
        { ...ROUTES[0], path: "/things/new" },
      ]),
    ).toEqual(["/things/:id overlaps /things/new"]);
  });

  test("a malformed segment matches nothing", () => {
    const routes = [{ ...ROUTES[0], path: "/things/:id" }];
    expect(match("/things/%E0%A4%A", routes)).toBeNull();
  });
});

describe("App before the first load answers", () => {
  test("a public route renders without waiting", () => {
    me.value = undefined;
    path.value = "/login";
    const html = render(<App />);
    expect(html).toContain("<form");
    path.value = "/";
    expect(render(<App />)).toBe("");
  });
});
