// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The root: a public route renders at once; anything else waits for
// the first load of me, with a retry when that load fails; the login
// view when nobody is signed in and the route needs someone; otherwise
// the shell, the rail beside the view.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { UserSummary } from "../../shared/contracts/user.ts";
import { loadMe, me, meError } from "../data/me.ts";
import { Icon, Mark } from "../lib/icons.tsx";
import { Login } from "../views/home/Login.tsx";
import { Rail } from "./Rail.tsx";
import { navigate, path } from "./router.ts";
import { match } from "./routes.ts";
import {
  closeDrawer,
  drawerOpen,
  hideRail,
  narrow,
  openDrawer,
  railHidden,
  showRail,
} from "./shell.ts";
import "./shell.css";

// wide: the rail is a column beside the view, or folded to a strip in
// its colour with the button that brings it back and the mark. Narrow:
// the rail is a full screen over the view, opened by the same button
// floating at the top left of the view; while it is open the view under
// it is inert, and when it closes the focus comes back to that button.
function Shell({
  user,
  children,
}: {
  user: UserSummary;
  children: ComponentChildren;
}) {
  const phone = narrow.value;
  const railShown = phone ? drawerOpen.value : !railHidden.value;
  const covered = phone && drawerOpen.value;
  const show = useRef<HTMLButtonElement>(null);
  const wasCovered = useRef(false);

  // Escape or arriving somewhere closes the full-screen rail
  useEffect(() => {
    if (!phone || !drawerOpen.value) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phone, drawerOpen.value]);
  useEffect(() => {
    closeDrawer();
  }, [path.value]);
  useEffect(() => {
    if (wasCovered.current && !covered) show.current?.focus();
    wasCovered.current = covered;
  }, [covered]);

  return (
    <div class="shell">
      {railShown && (
        <Rail
          user={user}
          narrow={phone}
          onHide={phone ? closeDrawer : hideRail}
        />
      )}
      {!railShown && !phone && (
        <aside class="shell-strip">
          <button
            type="button"
            class="shell-show"
            aria-label="Show the menu"
            onClick={showRail}
          >
            <Icon name="sidebar" />
          </button>
          <a class="shell-strip-mark" href="/" aria-label="Home">
            <Mark />
          </a>
        </aside>
      )}
      <main
        class={`shell-main${railShown ? "" : " shell-main-bare"}`}
        inert={covered}
      >
        {!railShown && phone && (
          <button
            ref={show}
            type="button"
            class="shell-show shell-show-float"
            aria-label="Show the menu"
            onClick={openDrawer}
          >
            <Icon name="sidebar" />
          </button>
        )}
        {children}
      </main>
    </div>
  );
}

export function App() {
  const user = me.value;
  const m = match(path.value);
  const needsUser = m === null || m.route.role !== "public";

  useEffect(() => {
    void loadMe();
  }, []);

  useEffect(() => {
    const title =
      user === null && needsUser ? "Sign in" : m ? m.route.title(m.params) : "";
    document.title = title ? `1ctx · ${title}` : "1ctx";
  }, [user, needsUser, m]);

  // a signed-in user on /login, or on a path with no route, lands on Home
  useEffect(() => {
    if (user && (m === null || m.route.path === "/login")) navigate("/", true);
  }, [user, m]);

  if (user === undefined) {
    // a public page needs nobody, so a slow or hanging first load does
    // not hold the sign-in form back
    if (!needsUser) {
      const View = m.route.view;
      return <View params={m.params} />;
    }
    if (meError.value === null) return null;
    return (
      <main class="shell-fail">
        <p class="error">{meError.value}</p>
        <button type="button" class="btn" onClick={() => void loadMe()}>
          Try again
        </button>
      </main>
    );
  }
  if (user === null) {
    if (needsUser) return <Login />;
    const View = m.route.view;
    return <View params={m.params} />;
  }
  if (m === null || m.route.path === "/login") return null;
  if (m.route.role === "admin" && user.role !== "admin") {
    return (
      <Shell user={user}>
        <p class="error">This page is for admins.</p>
      </Shell>
    );
  }
  const View = m.route.view;
  return (
    <Shell user={user}>
      <View params={m.params} />
    </Shell>
  );
}
