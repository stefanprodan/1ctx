// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail folded on a wide window: the button that brings it back, the
// mark, the rail's entries as icons, then the admin panel and the
// user's menu at the foot. Recent and the project list are lists with
// no page of their own, so they wait for the rail.

import type { Me } from "../../shared/contracts/user.ts";
import { initials } from "../lib/format.ts";
import { Icon, Mark } from "../lib/icons.tsx";
import { adminFace, navLit, onPage } from "./Rail.model.ts";
import { projectOnScreen } from "./Rail.tsx";
import { path } from "./router.ts";
import { navEntries } from "./routes.ts";
import { lastAdmin, showRail } from "./shell.ts";
import { toggleUserMenu, UserMenu, userMenuOpen } from "./UserMenu.tsx";
import "./strip.css";

// Projects stays lit on every page inside a project, as the rail lights
// that project's row
function stripLit(here: string, href: string): boolean {
  if (href !== "/projects") return navLit(here, href);
  return onPage(here, href) || projectOnScreen(here) !== null;
}

export function Strip({ user }: { user: Me }) {
  const here = path.value;
  return (
    <aside class="strip">
      <button
        type="button"
        class="btn-icon strip-show"
        aria-label="Show the menu"
        title="Show the menu"
        onClick={showRail}
      >
        <Icon name="sidebar" />
      </button>
      <a class="strip-mark" href="/" aria-label="Home" title="Home">
        <Mark />
      </a>
      <nav class="strip-nav">
        {navEntries().map((route) => (
          <a
            key={route.path}
            href={route.path}
            class={`strip-item${stripLit(here, route.path) ? " strip-item-on" : ""}`}
            aria-current={here === route.path ? "page" : undefined}
            aria-label={route.nav!.label}
            title={route.nav!.label}
          >
            <Icon name={route.nav!.icon} />
          </a>
        ))}
      </nav>
      <div class="strip-foot">
        {user.role === "admin" && (
          <a
            class={`strip-item${adminFace(here) ? " strip-item-on" : ""}`}
            href={lastAdmin.value}
            aria-label="Admin panel"
            title="Admin panel"
          >
            <Icon name="panel" />
          </a>
        )}
        <UserMenu wrap="strip-user" place="strip-menu">
          <button
            type="button"
            class="strip-avatar"
            aria-expanded={userMenuOpen.value}
            aria-label={user.fullName}
            title={user.fullName}
            onClick={toggleUserMenu}
          >
            <span class="avatar">{initials(user.fullName)}</span>
          </button>
        </UserMenu>
      </div>
    </aside>
  );
}
