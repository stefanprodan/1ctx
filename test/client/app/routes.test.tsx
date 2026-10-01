// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The route table: every path matches itself and nothing else, every
// view renders, an admin route is out of a member's rail.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { App } from "../../../src/client/app/App.tsx";
import { adminFace, zoneLit } from "../../../src/client/app/Rail.model.ts";
import { path } from "../../../src/client/app/router.ts";
import {
  ALIASES,
  conflicts,
  match,
  navEntries,
  ROUTES,
} from "../../../src/client/app/routes.ts";
import { ZONES } from "../../../src/client/app/zones.ts";
import { me } from "../../../src/client/data/me.ts";
import { session } from "../../../src/client/data/sessions.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";

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
      username: "casey",
      fullName: "Casey",
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

  test("the working face lists Home, Projects and Directory", () => {
    expect(navEntries().map((r) => r.path)).toEqual([
      "/",
      "/projects",
      "/directory",
    ]);
  });

  test("every zone address is an admin route, and every admin route is in a zone", () => {
    for (const zone of ZONES) {
      for (const href of [zone.href, ...zone.pages.map((p) => p.href)]) {
        expect(match(href)?.route.role, href).toBe("admin");
      }
    }
    for (const route of ROUTES.filter((r) => r.role === "admin")) {
      expect(adminFace(route.path), route.path).toBe(true);
      expect(route.path.startsWith("/admin/"), route.path).toBe(true);
    }
    for (const route of ROUTES.filter((r) => r.path.startsWith("/admin"))) {
      expect(route.role, route.path).toBe("admin");
    }
  });

  test("the rail lights the zone page an address sits under", () => {
    expect(zoneLit("/admin/config/deciders")).toBe("/admin/config/deciders");
    expect(zoneLit("/admin/config/deciders/jev")).toBe(
      "/admin/config/deciders",
    );
    // the Decisions tab stands for Deciders
    expect(zoneLit("/admin/config/decisions")).toBe("/admin/config/deciders");
    expect(zoneLit("/admin/config/decisions/run-attention")).toBe(
      "/admin/config/deciders",
    );
    expect(zoneLit("/admin/config")).toBe("/admin/config");
    expect(zoneLit("/admin/config/agents/x/mcp")).toBe("/admin/config/agents");
    expect(zoneLit("/projects")).toBeNull();
  });

  test("every route has a title", () => {
    for (const route of ROUTES) expect(route.title({})).not.toBe("");
  });
});

describe("the route table's shape", () => {
  test("an alias has no page of its own and opens one that exists", () => {
    expect(ALIASES["/admin"]).toBe("/admin/monitor");
    for (const [from, to] of Object.entries(ALIASES)) {
      expect(match(from), from).toBeNull();
      expect(match(to)?.route.path, to).toBe(to);
    }
  });

  test("no route shadows another", () => {
    expect(conflicts()).toEqual([]);
    expect(
      conflicts([
        { ...ROUTES[0], path: "/things/:id" },
        { ...ROUTES[0], path: "/things/new" },
      ]),
    ).toEqual(["/things/:id overlaps /things/new"]);
  });

  test("a page's tabs share one view and title each tab", () => {
    const tabs = [
      ["/admin/config/mcp/x1", "x1"],
      ["/admin/config/mcp/x1/tools", "x1 tools"],
    ] as const;
    const views = new Set();
    for (const [at, title] of tabs) {
      const m = match(at);
      views.add(m?.route.view);
      expect(m?.route.title(m.params)).toBe(title);
    }
    expect(views.size).toBe(1);
    expect(match("/admin/config/web")?.route.view).toBe(
      match("/admin/config/web/credentials")?.route.view,
    );
  });

  test("a malformed segment matches nothing", () => {
    const routes = [{ ...ROUTES[0], path: "/things/:id" }];
    expect(match("/things/%E0%A4%A", routes)).toBeNull();
  });
});

describe("a session's page", () => {
  test("a chat is at /chat and a run at /run", () => {
    const chat = match("/chat/s1");
    const run = match("/run/s1");
    expect(chat?.route.title(chat.params)).toBe("Chat");
    expect(run?.route.title(run.params)).toBe("Run");
    expect(run?.params).toEqual({ id: "s1" });
    expect(run?.route.view).toBe(match("/run/s2")?.route.view);
  });

  test.serial("each page refuses the other origin", async () => {
    const Chat = match("/chat/s1")!.route.view;
    const Run = match("/run/s1")!.route.view;
    await Promise.all([Chat.load(), Run.load()]);
    const detail = (origin: "chat" | "automation") =>
      ({ session: { id: "s1", origin } }) as SessionDetail;
    try {
      session.value = detail("automation");
      expect(render(<Chat params={{ id: "s1" }} />)).toContain("No such chat.");
      session.value = detail("chat");
      expect(render(<Run params={{ id: "s1" }} />)).toContain("No such run.");
    } finally {
      session.value = null;
    }
  });
});

describe("App before the first load answers", () => {
  test.serial("a public route renders without waiting", async () => {
    await match("/login")!.route.view.load();
    const held = [me.value, path.value] as const;
    try {
      me.value = undefined;
      path.value = "/login";
      const html = render(<App />);
      expect(html).toContain("<form");
      path.value = "/";
      expect(render(<App />)).toBe("");
    } finally {
      [me.value, path.value] = held;
    }
  });
});
