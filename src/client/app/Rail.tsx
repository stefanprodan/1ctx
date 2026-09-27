// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail, with two faces the address picks. The working face lists the
// pages the route table marks with the user's projects under Projects,
// personal first; the admin face has the zones, each a header link with
// its pages under it, and a faint Admin after the logo. An admin gets a
// band over the user row between the faces, each opening the last page
// seen on the other. At the bottom the user row with its menu: the
// profile, the dark theme's switch and sign out. A sign out the server
// refuses stays in the menu with the reason. As a drawer the hide button is a close, it takes the focus
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
import { initials, says } from "../lib/format.ts";
import { Icon, type IconName, Logo, projectIcon } from "../lib/icons.tsx";
import { adminFace, litPage, onPage, projectHere } from "./Rail.model.ts";
import { navigate, path } from "./router.ts";
import { navEntries } from "./routes.ts";
import { lastAdmin, lastWork } from "./shell.ts";
import { theme, toggleTheme } from "./theme.ts";
import { ZONES } from "./zones.ts";
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
  // a project's kind; a zone's pages have none
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

// the admin face: every zone open, its header the zone's overview; one
// link is lit, the longest that holds the address, so an agent's page
// lights Agents
function Zones({ here, follow }: { here: string; follow?: () => void }) {
  const lit = litPage(
    here,
    ZONES.flatMap((z) => [z.href, ...z.pages.map((p) => p.href)]),
  );
  return (
    <>
      {ZONES.map((z) => (
        <Fragment key={z.href}>
          <a
            href={z.href}
            class={`rail-item rail-zone${lit === z.href ? " rail-item-on" : ""}${
              lit !== null && onPage(lit, z.href) ? " rail-item-in" : ""
            }`}
            aria-current={here === z.href ? "page" : undefined}
            onClick={follow}
          >
            <Icon name={z.icon} />
            <span>{z.label}</span>
          </a>
          {z.pages.map((p) => (
            <Sub
              key={p.href}
              href={p.href}
              here={here}
              on={p.href === lit}
              follow={follow}
            >
              {p.label}
            </Sub>
          ))}
        </Fragment>
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
  const admin = adminFace(here);
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
          {admin && <span class="rail-face">Admin</span>}
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
          {admin ? (
            <Zones here={here} follow={follow} />
          ) : (
            navEntries().map((route) => (
              <Fragment key={route.path}>
                <a
                  href={route.path}
                  class={`rail-item${here === route.path ? " rail-item-on" : ""}`}
                  aria-current={here === route.path ? "page" : undefined}
                  onClick={follow}
                >
                  <Icon name={route.nav!.icon} />
                  <span>{route.nav!.label}</span>
                </a>
                {route.path === "/projects" &&
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
            ))
          )}
        </nav>
      </div>
      {user.role === "admin" && (
        <a
          class="rail-band"
          href={admin ? lastWork.value : lastAdmin.value}
          onClick={follow}
        >
          <Icon name={admin ? "home" : "panel"} />
          <span>{admin ? "Exit admin panel" : "Admin panel"}</span>
          <Icon name="open" size={14} class="rail-band-open" />
        </a>
      )}
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
                  failure.value = says(err);
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
