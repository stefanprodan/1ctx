// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail: the logo with the button that hides it, the pages the route
// table lists with the user's projects under Projects, personal first,
// a group as a row that opens to its pages, open while one is shown,
// and the user row at the bottom with its menu: the profile and sign
// out. A sign out the server refuses stays in the menu with the
// reason. As a drawer the hide button is a close, it takes the focus
// when the drawer opens, and any link closes the drawer, the one to the
// page already shown included, since that is no navigation.

import { useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { logout } from "../data/me.ts";
import { projects } from "../data/projects.ts";
import { initials } from "../lib/format.ts";
import { Icon, type IconName, Logo } from "../lib/icons.tsx";
import { navigate, path } from "./router.ts";
import { type Route, railRows } from "./routes.ts";
import "./rail.css";

function Sub({
  href,
  here,
  follow,
  children,
}: {
  href: string;
  here: string;
  follow?: () => void;
  children: string;
}) {
  const on = here === href;
  return (
    <a
      href={href}
      class={`rail-sub${on ? " rail-sub-on" : ""}`}
      aria-current={on ? "page" : undefined}
      onClick={follow}
    >
      {children}
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
  const inside = routes.some((r) => r.path === here);
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
  user: UserSummary;
  narrow: boolean;
  onHide: () => void;
}) {
  const open = useSignal(false);
  const failure = useSignal<string | null>(null);
  const here = path.value;
  const hide = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (narrow) hide.current?.focus();
  }, [narrow]);
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
            class="rail-hide"
            aria-label={narrow ? "Close the menu" : "Hide the menu"}
            onClick={onHide}
          >
            <Icon name={narrow ? "close" : "sidebar"} />
          </button>
        </div>
        <nav class="rail-nav">
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
          <div class="rail-menu">
            <a
              class="rail-menu-item"
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
              class="rail-menu-item"
              onClick={async () => {
                failure.value = null;
                try {
                  await logout();
                } catch (err) {
                  failure.value =
                    err instanceof Error ? err.message : String(err);
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
          <span class="rail-avatar">{initials(user.fullName)}</span>
          <span class="rail-user-name">{user.fullName}</span>
          <Icon name="chevron" size={14} class="rail-user-chevron" />
        </button>
      </div>
    </aside>
  );
}
