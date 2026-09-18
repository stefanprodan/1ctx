// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail: the logo with the button that hides it, the pages the route
// table lists with the user's projects under Projects, personal first,
// a group as a row that opens to its pages, open while one is shown,
// and the user row at the bottom with its menu: the profile, the dark
// theme's switch and sign out. A sign out the server refuses stays in the menu with the
// reason. As a drawer the hide button is a close, it takes the focus
// when the drawer opens, and any link closes the drawer, the one to the
// page already shown included, since that is no navigation.

import { useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Me } from "../../shared/contracts/user.ts";
import { automationProject } from "../data/automations.ts";
import { logout } from "../data/me.ts";
import { projects } from "../data/projects.ts";
import { session } from "../data/sessions.ts";
import { initials, reason } from "../lib/format.ts";
import { Icon, type IconName, Logo, projectIcon } from "../lib/icons.tsx";
import { onPage, projectHere } from "./Rail.model.ts";
import { navigate, path } from "./router.ts";
import { type Route, railRows } from "./routes.ts";
import { theme, toggleTheme } from "./theme.ts";
import "./rail.css";

function Sub({
  href,
  here,
  on = onPage(here, href),
  icon,
  follow,
  children,
}: {
  href: string;
  here: string;
  // inside the link's page, not only on it
  on?: boolean;
  // a project's kind; a group's pages have none
  icon?: IconName;
  follow?: () => void;
  children: string;
}) {
  return (
    <a
      href={href}
      class={`rail-sub${icon ? " rail-sub-icon" : ""}${on ? " rail-sub-on" : ""}`}
      aria-current={here === href ? "page" : undefined}
      onClick={follow}
    >
      {icon ? (
        <>
          <Icon name={icon} size={14} class="rail-sub-glyph" />
          <span class="rail-sub-name">{children}</span>
        </>
      ) : (
        children
      )}
    </a>
  );
}

// a row that opens to its pages: open by the user, or while one of its
// pages is on screen
function Group({
  name,
  icon,
  routes,
  here,
  follow,
}: {
  name: string;
  icon: IconName;
  routes: Route[];
  here: string;
  follow?: () => void;
}) {
  const inside = routes.some((r) => onPage(here, r.path));
  const open = useSignal(inside);
  useEffect(() => {
    if (inside) open.value = true;
  }, [inside]);
  return (
    <>
      <button
        type="button"
        class={`rail-item rail-group${inside ? " rail-item-in" : ""}`}
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <Icon name={icon} />
        <span>{name}</span>
        <Icon
          name="chevron"
          size={14}
          class={`rail-item-chevron${open.value ? " rail-item-chevron-open" : ""}`}
        />
      </button>
      {open.value &&
        routes.map((r) => (
          <Sub key={r.path} href={r.path} here={here} follow={follow}>
            {r.nav!.label}
          </Sub>
        ))}
    </>
  );
}

export function Rail({
  user,
  narrow,
  onHide,
}: {
  user: Me;
  narrow: boolean;
  onHide: () => void;
}) {
  const open = useSignal(false);
  const failure = useSignal<string | null>(null);
  const here = path.value;
  const inProject = projectHere(here, session.value, automationProject.value);
  const hide = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (narrow) hide.current?.focus();
  }, [narrow]);
  // the list scrolls inside the rail, so the project on screen is kept in
  // view when it sits below the fold, after a reload or a link elsewhere
  useEffect(() => {
    nav.current
      ?.querySelector(".rail-sub-on")
      ?.scrollIntoView({ block: "nearest" });
  }, [here, inProject, projects.value]);
  const follow = narrow ? onHide : undefined;
  return (
    <aside class={`rail${narrow ? " rail-drawer" : ""}`}>
      <div class="rail-top">
        <div class="rail-head">
          <a class="rail-logo" href="/" aria-label="Home" onClick={follow}>
            <Logo height={26} />
          </a>
          <button
            ref={hide}
            type="button"
            class="btn-icon rail-hide"
            aria-label={narrow ? "Close the menu" : "Hide the menu"}
            onClick={onHide}
          >
            <Icon name={narrow ? "close" : "sidebar"} />
          </button>
        </div>
        <nav ref={nav} class="rail-nav">
          {railRows(user.role).map((row) =>
            row.kind === "group" ? (
              <Group
                key={row.name}
                name={row.name}
                icon={row.icon}
                routes={row.routes}
                here={here}
                follow={follow}
              />
            ) : (
              <Fragment key={row.route.path}>
                <a
                  href={row.route.path}
                  class={`rail-item${here === row.route.path ? " rail-item-on" : ""}`}
                  aria-current={here === row.route.path ? "page" : undefined}
                  onClick={follow}
                >
                  <Icon name={row.route.nav!.icon} />
                  <span>{row.route.nav!.label}</span>
                </a>
                {row.route.path === "/projects" &&
                  (projects.value ?? []).map((p) => (
                    <Sub
                      key={p.id}
                      href={`/projects/${p.id}`}
                      here={here}
                      on={p.id === inProject}
                      icon={projectIcon(p.kind)}
                      follow={follow}
                    >
                      {p.name}
                    </Sub>
                  ))}
              </Fragment>
            ),
          )}
        </nav>
      </div>
      <div class="rail-user">
        {open.value && (
          <div class="menu rail-menu">
            <a
              class="menu-item"
              href="/profile"
              onClick={() => {
                open.value = false;
                follow?.();
              }}
            >
              <Icon name="user" size={14} />
              <span>Profile</span>
            </a>
            <button
              type="button"
              role="switch"
              aria-checked={theme.value === "dark"}
              class="menu-item"
              onClick={toggleTheme}
            >
              <Icon name="moon" size={14} />
              <span>Dark theme</span>
              <span
                class={`rail-menu-switch switch${theme.value === "dark" ? " switch-on" : ""}`}
              >
                <span class="switch-knob" />
              </span>
            </button>
            <button
              type="button"
              class="menu-item"
              onClick={async () => {
                failure.value = null;
                try {
                  await logout();
                } catch (err) {
                  failure.value = reason(err);
                  return;
                }
                open.value = false;
                navigate("/login", true);
              }}
            >
              <Icon name="sign-out" size={14} />
              <span>Sign out</span>
            </button>
            {failure.value && (
              <p class="rail-menu-error error">{failure.value}</p>
            )}
          </div>
        )}
        <button
          type="button"
          class="rail-user-row"
          aria-expanded={open.value}
          onClick={() => {
            open.value = !open.value;
          }}
        >
          <span class="avatar">{initials(user.fullName)}</span>
          <span class="rail-user-name cut">{user.fullName}</span>
          <Icon name="chevron" size={14} class="rail-user-chevron" />
        </button>
      </div>
    </aside>
  );
}
