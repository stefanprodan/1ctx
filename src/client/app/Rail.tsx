// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail: the logo, the pages the route table lists, and the user row
// at the bottom with its menu. The menu holds only what exists: sign out.
// A sign out the server refuses stays in the menu with the reason.

import { useSignal } from "@preact/signals";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { logout } from "../data/me.ts";
import { Icon, Logo } from "../lib/icons.tsx";
import { navigate, path } from "./router.ts";
import { navEntries } from "./routes.ts";
import "./rail.css";

export function Rail({ user }: { user: UserSummary }) {
  const open = useSignal(false);
  const failure = useSignal<string | null>(null);
  const here = path.value;
  const initials = user.name.slice(0, 2).toUpperCase();
  return (
    <aside class="rail">
      <div class="rail-top">
        <a class="rail-logo" href="/" aria-label="Home">
          <Logo height={26} />
        </a>
        <nav class="rail-nav">
          {navEntries(user.role).map((route) => (
            <a
              key={route.path}
              href={route.path}
              class={`rail-item${here === route.path ? " rail-item-on" : ""}`}
            >
              <Icon name={route.nav!.icon} />
              <span>{route.nav!.label}</span>
            </a>
          ))}
        </nav>
      </div>
      <div class="rail-user">
        {open.value && (
          <div class="rail-menu">
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
          <span class="rail-avatar">{initials}</span>
          <span class="rail-user-name">{user.name}</span>
          <Icon name="chevron" size={14} class="rail-user-chevron" />
        </button>
      </div>
    </aside>
  );
}
