// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The folded rail keeps the rail's entries as icons, each lit on its
// pages and Projects on every page inside a project; the admin panel
// is an admin's alone; the user's menu opens from the avatar and its
// links close it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import { Strip } from "../../../src/client/app/Strip.tsx";
import { lastAdmin } from "../../../src/client/app/shell.ts";
import { userMenuOpen } from "../../../src/client/app/UserMenu.tsx";
import { automationProject } from "../../../src/client/data/automations.ts";
import { taskPage } from "../../../src/client/data/external-task.ts";
import { session } from "../../../src/client/data/sessions.ts";
import type { Me } from "../../../src/shared/contracts/user.ts";

const casey: Me = {
  id: "u1",
  username: "casey",
  fullName: "Casey",
  role: "member",
  mustChangePassword: false,
};
const admin: Me = { ...casey, role: "admin" };

// the entries lit in a render, by their names
const lit = (html: string) =>
  [
    ...html.matchAll(
      /class="strip-item strip-item-on"[^>]*aria-label="([^"]+)"/g,
    ),
  ].map((m) => m[1]);

// the click handlers of a render's elements, by a prop's value
function handlers(
  user: Me,
  pick: (type: unknown, props: Record<string, unknown>) => boolean,
) {
  const found: (() => void)[] = [];
  const previous = options.vnode;
  options.vnode = (v: VNode) => {
    previous?.(v);
    const props = v.props as Record<string, unknown>;
    if (pick(v.type, props)) found.push(props.onClick as () => void);
  };
  try {
    render(<Strip user={user} />);
  } finally {
    options.vnode = previous;
  }
  return found;
}

beforeEach(() => {
  path.value = "/";
  lastAdmin.value = "/admin/monitor";
  userMenuOpen.value = false;
});

afterEach(() => {
  session.value = null;
  automationProject.value = null;
  taskPage.value = null;
  path.value = "/";
  userMenuOpen.value = false;
});

describe("the strip's entries", () => {
  test.serial("are the rail's, in its order, each named", () => {
    const html = render(<Strip user={casey} />);
    const names = [
      ...html.matchAll(
        /class="strip-item[^"]*"[^>]*aria-label="([^"]+)" title="\1"/g,
      ),
    ].map((m) => m[1]);
    expect(names).toEqual(["Home", "Directory", "Projects"]);
    expect(html).toContain('aria-label="Show the menu" title="Show the menu"');
    expect(html).toContain('aria-label="Casey" title="Casey"');
    // the lists wait for the rail
    expect(html).not.toContain("Recent");
    expect(html).not.toContain("rail-sub");
  });

  test.serial("each is lit on its own pages", () => {
    expect(lit(render(<Strip user={casey} />))).toEqual(["Home"]);
    path.value = "/directory";
    expect(lit(render(<Strip user={casey} />))).toEqual(["Directory"]);
    path.value = "/users/robin";
    expect(lit(render(<Strip user={casey} />))).toEqual(["Directory"]);
    path.value = "/projects";
    expect(lit(render(<Strip user={casey} />))).toEqual(["Projects"]);
    path.value = "/profile";
    expect(lit(render(<Strip user={casey} />))).toEqual([]);
  });

  test.serial("Projects stays lit on every page of a project", () => {
    const projects = () => lit(render(<Strip user={casey} />));
    session.value = {
      session: { id: "s1", projectId: "p1" },
    } as unknown as typeof session.value;
    path.value = "/chat/s1";
    expect(projects()).toEqual(["Projects"]);
    path.value = "/run/s1";
    expect(projects()).toEqual(["Projects"]);
    // another chat than the one read is in no project yet
    path.value = "/chat/s9";
    expect(projects()).toEqual([]);
    automationProject.value = { id: "a1", projectId: "p1" };
    path.value = "/automations/a1";
    expect(projects()).toEqual(["Projects"]);
    path.value = "/automations/a1/memory";
    expect(projects()).toEqual(["Projects"]);
    taskPage.value = {
      id: "t1",
      detail: { task: { projectId: "p1" } },
    } as unknown as typeof taskPage.value;
    path.value = "/external-tasks/t1";
    expect(projects()).toEqual(["Projects"]);
    path.value = "/projects/p1/knowledge/files/f1";
    expect(projects()).toEqual(["Projects"]);
  });
});

describe("the strip's foot", () => {
  test.serial("offers the admin panel to an admin only", () => {
    expect(render(<Strip user={casey} />)).not.toContain("Admin panel");
    const html = render(<Strip user={admin} />);
    expect(html).toContain(
      'href="/admin/monitor" aria-label="Admin panel" title="Admin panel"',
    );
    expect(lit(html)).toEqual(["Home"]);
    path.value = "/admin/config/agents";
    expect(lit(render(<Strip user={admin} />))).toEqual(["Admin panel"]);
  });

  test.serial("the avatar opens and closes the user's menu", () => {
    const avatar = () =>
      handlers(casey, (t, p) => t === "button" && p.class === "strip-avatar");
    expect(render(<Strip user={casey} />)).not.toContain("Connect agents");
    avatar()[0]?.();
    expect(userMenuOpen.value).toBe(true);
    const html = render(<Strip user={casey} />);
    expect(html).toContain('class="menu strip-menu"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('href="/profile"');
    expect(html).toContain('href="/connect"');
    expect(html).toContain("Sign out");
    // the avatar sits in the menu's box, so its click is no click
    // outside and toggles the menu rather than closing it twice
    expect(html).toMatch(
      /<div class="strip-user"><div class="menu strip-menu">.*<button[^>]*class="strip-avatar"[^>]*>.*<\/button><\/div>/,
    );
    avatar()[0]?.();
    expect(userMenuOpen.value).toBe(false);
    expect(render(<Strip user={casey} />)).not.toContain("strip-menu");
  });

  test.serial("a link in the menu leaves it closed", () => {
    for (const href of ["/profile", "/connect"]) {
      userMenuOpen.value = true;
      const [follow] = handlers(
        casey,
        (t, p) => t === "a" && p.class === "menu-item" && p.href === href,
      );
      expect(follow).toBeDefined();
      follow?.();
      expect(userMenuOpen.value).toBe(false);
    }
  });
});
