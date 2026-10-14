// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The signed-in user's menu: profile, connect agents, the theme and
// sign out. The rail opens it from its user row and the strip from its
// avatar, which the owner passes as the child; each owner places it
// with its own classes. A click outside or Escape closes it.

import { signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { logout } from "../data/me.ts";
import { says } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import { navigate } from "./router.ts";
import { theme, toggleTheme } from "./theme.ts";
import "./usermenu.css";

// one for both owners, which never show together; the owner leaving
// closes it, so the rail folded or a drawer closed opens it shut
export const userMenuOpen = signal(false);

export function toggleUserMenu(): void {
  userMenuOpen.value = !userMenuOpen.value;
}

export function UserMenu({
  wrap,
  place,
  follow,
  children,
}: {
  // the owner's classes for the box around the menu and its button,
  // and for the menu, which position it
  wrap: string;
  place: string;
  // what the owner does once a link is followed
  follow?: () => void;
  // the button that opens it, inside the box so its click is no
  // click outside
  children: ComponentChildren;
}) {
  const failure = useSignal<string | null>(null);
  const { root } = useMenu(undefined, userMenuOpen);
  useEffect(
    () => () => {
      userMenuOpen.value = false;
    },
    [],
  );
  const done = () => {
    userMenuOpen.value = false;
    follow?.();
  };
  return (
    <div ref={root} class={wrap}>
      {userMenuOpen.value && (
        <div class={`menu ${place}`}>
          <a class="menu-item" href="/profile" onClick={done}>
            <Icon name="user" size={14} />
            <span>Profile</span>
          </a>
          <a class="menu-item" href="/connect" onClick={done}>
            <Icon name="plug" size={14} />
            <span>Connect agents</span>
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
              class={`usermenu-switch switch${theme.value === "dark" ? " switch-on" : ""}`}
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
              userMenuOpen.value = false;
              navigate("/login", true);
            }}
          >
            <Icon name="sign-out" size={14} />
            <span>Sign out</span>
          </button>
          {failure.value && <p class="usermenu-error error">{failure.value}</p>}
        </div>
      )}
      {children}
    </div>
  );
}
