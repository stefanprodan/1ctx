// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Directory draws the list its address names, the rail lights it
// on the pages it lists, and the pages' crumbs lead back to it.

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { navLit } from "../../../src/client/app/Rail.model.ts";
import { path } from "../../../src/client/app/router.ts";
import {
  agentPage,
  directoryAgents,
  directoryAgentsError,
  directoryUsers,
  directoryUsersError,
  userPage,
} from "../../../src/client/data/directory.ts";
import { me } from "../../../src/client/data/me.ts";
import { Agent } from "../../../src/client/views/directory/Agent.tsx";
import {
  agentTabHref,
  directoryTab,
  directoryTabs,
  userTabHref,
} from "../../../src/client/views/directory/Directory.model.ts";
import { Directory } from "../../../src/client/views/directory/Directory.tsx";
import { User } from "../../../src/client/views/directory/User.tsx";

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey Doe",
    role: "member",
    mustChangePassword: false,
  };
  directoryUsers.value = [
    {
      id: "u1",
      username: "casey",
      fullName: "Casey Doe",
      role: "member",
      tz: "UTC",
    },
    {
      id: "u2",
      username: "admin",
      fullName: "Ada Min",
      role: "admin",
      tz: "Europe/Bucharest",
    },
  ];
  directoryUsersError.value = null;
  directoryAgents.value = [
    {
      id: "a1",
      name: "coder",
      avatar: "bot",
      default: true,
      model: "deepseek/deepseek-v4-flash",
    },
  ];
  directoryAgentsError.value = null;
});

describe("the directory", () => {
  test("the tab is the address, Users for any other", () => {
    expect(directoryTab("/directory")).toBe("users");
    expect(directoryTab("/directory/agents")).toBe("agents");
    expect(directoryTab("/directory/else")).toBe("users");
    expect(directoryTabs(2, undefined)).toEqual([
      { label: "Users", href: "/directory", count: 2 },
      { label: "Agents", href: "/directory/agents", count: undefined },
    ]);
  });

  test.serial("the Users tab lists each user with the role, you marked", () => {
    path.value = "/directory";
    const html = render(<Directory />);
    expect(html).toContain('href="/users/casey"');
    expect(html).toContain('href="/users/admin"');
    expect(html).toContain("@admin");
    expect(html).toContain("Admin");
    expect(html).toContain("you");
    expect(html).not.toContain('rows-go" href="/agents/coder"');
    expect(html).toContain("Admins");
  });

  test.serial("the Agents tab lists each agent with its model", () => {
    path.value = "/directory/agents";
    const html = render(<Directory />);
    expect(html).toContain('href="/agents/coder"');
    expect(html).toContain("@coder");
    expect(html).toContain("default");
    expect(html).toContain("deepseek/deepseek-v4-flash");
    expect(html).not.toContain('rows-go" href="/users/casey"');
  });

  test.serial("a failed list says so on its own tab", () => {
    path.value = "/directory/agents";
    directoryAgents.value = null;
    directoryAgentsError.value = { words: "Could not load", status: 500 };
    expect(render(<Directory />)).toContain("Could not load");
  });

  test.serial("a user's crumb is Directory / Users, Users to its tab", () => {
    path.value = "/users/casey";
    userPage.value = null;
    const html = render(<User params={{ username: "casey" }} />);
    expect(html).toMatch(
      /href="\/directory">Directory<\/a>.*href="\/directory">Users<\/a>.*@casey/,
    );
  });

  test.serial(
    "an agent's crumb is Directory / Agents, Agents to its tab",
    () => {
      path.value = "/agents/coder";
      agentPage.value = null;
      const html = render(<Agent params={{ name: "coder" }} />);
      expect(html).toMatch(
        /href="\/directory">Directory<\/a>.*href="\/directory\/agents">Agents<\/a>.*@coder/,
      );
    },
  );

  test("the name's switcher keeps the tab on screen", () => {
    expect(userTabHref("radu", 0)).toBe("/users/radu");
    expect(userTabHref("radu", 1)).toBe("/users/radu/projects");
    expect(agentTabHref("sre", 0)).toBe("/agents/sre");
    expect(agentTabHref("sre", 3)).toBe("/agents/sre/mcp");
  });

  test("the rail lights the Directory on its tabs and the pages it lists", () => {
    for (const at of [
      "/directory",
      "/directory/agents",
      "/users/casey",
      "/agents/coder",
    ]) {
      expect(navLit(at, "/directory")).toBe(true);
    }
    expect(navLit("/projects", "/directory")).toBe(false);
    expect(navLit("/projects", "/projects")).toBe(true);
    expect(navLit("/projects/p1", "/projects")).toBe(false);
  });
});
