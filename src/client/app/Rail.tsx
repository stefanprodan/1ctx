// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail: the logo with the button that hides it, the pages the route
// table lists with the user's projects under Projects, personal first,
// and the user row at the bottom with its menu: the profile and sign
// out. A sign out the server refuses stays in the menu
// with the reason. As a drawer the hide button is a close, it takes the
// focus when the drawer opens, and any link closes the drawer, the one
// to the page already shown included, since that is no navigation.

import { useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { logout } from "../data/me.ts";
import { loadProjects, projects } from "../data/projects.ts";
import { initials } from "../lib/format.ts";
import { Icon, Logo } from "../lib/icons.tsx";
import { navigate, path } from "./router.ts";
import { navEntries } from "./routes.ts";
import "./rail.css";

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
  useEffect(() => {
    if (projects.value === null) void loadProjects();
  }, []);
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
          {navEntries(user.role).map((route) => (
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
                  <a
                    key={p.id}
                    href={`/projects/${p.id}`}
                    class={`rail-sub${here === `/projects/${p.id}` ? " rail-sub-on" : ""}`}
                    aria-current={
                      here === `/projects/${p.id}` ? "page" : undefined
                    }
                    onClick={follow}
                  >
                    {p.name}
                  </a>
                ))}
            </Fragment>
          ))}
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
