// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The root: a public route renders at once; anything else waits for
// the first load of me in the shell's shape, with a retry when that
// load fails; the login
// view when nobody is signed in and the route needs someone; otherwise
// the shell, the rail beside the view.

import { effect } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Me } from "../../shared/contracts/user.ts";
import { loadMe, me, meError } from "../data/me.ts";
import { Icon } from "../lib/icons.tsx";
import { type HandedWait, HandOver, useHandOver } from "../lib/wait.ts";
import { Bone } from "../ui/Bones.tsx";
import { PageWaiting } from "../ui/PageWaiting.tsx";
import { SignIn } from "../views/home/SignIn.tsx";
import { Rail, RailWaiting } from "./Rail.tsx";
import { navigate, path, query } from "./router.ts";
import { ALIASES, match } from "./routes.ts";
import {
  closeDrawer,
  drawerOpen,
  hideRail,
  openDrawer,
  railDrawer,
  railHidden,
} from "./shell.ts";
import "./shell.css";
import { PageCodeWaiting } from "./lazy.ts";
import { Strip, StripWaiting } from "./Strip.tsx";

// wide: the rail is a column beside the view, or folded to the strip of
// its entries as icons. Narrow or short: the rail is a full screen over
// the view, opened by the same button floating at the top left of the
// view; while it is open the view under it is inert, and when it closes
// the focus comes back to that button. Before the user is known it is
// the same frame in bones, with nothing to open.
function Shell({
  user,
  waited,
  children,
}: {
  user: Me | undefined;
  // the shell's wait while it is carried (useHandOver)
  waited: HandedWait;
  children: ComponentChildren;
}) {
  const phone = railDrawer.value;
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
  }, [phone, drawerOpen.value, path.value]);
  useEffect(() => {
    closeDrawer();
  }, [path.value]);
  // a new path starts at the top; the signal effect runs before the
  // render, so a view that opens at its end (a chat) scrolls after
  const main = useRef<HTMLElement>(null);
  useEffect(
    () =>
      effect(() => {
        path.value;
        main.current?.scrollTo(0, 0);
      }),
    [],
  );
  useEffect(() => {
    if (wasCovered.current && !covered) show.current?.focus();
    wasCovered.current = covered;
  }, [covered]);

  return (
    <div class="shell">
      {railShown &&
        (user === undefined ? (
          <RailWaiting />
        ) : (
          <Rail
            user={user}
            narrow={phone}
            onHide={phone ? closeDrawer : hideRail}
          />
        ))}
      {!railShown &&
        !phone &&
        (user === undefined ? <StripWaiting /> : <Strip user={user} />)}
      <main
        ref={main}
        class={`shell-main${railShown ? "" : " shell-main-bare"}${
          waited.waited === null ? "" : " bones-waited"
        }`}
        style={
          waited.waited === null
            ? undefined
            : { "--waited": `${waited.waited}ms` }
        }
        inert={covered}
      >
        {!railShown && phone && user === undefined && (
          <span
            class="btn-icon shell-show shell-show-float bones-wait"
            aria-hidden="true"
          >
            <Bone kind="glyph" at={0} />
          </span>
        )}
        {!railShown && phone && user !== undefined && (
          <button
            ref={show}
            type="button"
            class="btn-icon shell-show shell-show-float"
            aria-label="Show the menu"
            onClick={openDrawer}
          >
            <Icon name="sidebar" />
          </button>
        )}
        <HandOver.Provider value={waited.since}>{children}</HandOver.Provider>
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
  // the shell waits for me, then for the view's code, as one wait
  const shellWaits =
    (user === undefined && needsUser && meError.value === null) ||
    (user != null && m !== null && !m.route.view.settled());
  // the view's code loads beside me, not once me lands, and loads even
  // where the shell draws no view, so the wait always ends
  if (shellWaits && m !== null && !m.route.view.settled()) {
    void m.route.view.load();
  }
  const waited = useHandOver(shellWaits, path.value);

  useEffect(() => {
    if (!user) return;
    const alias = ALIASES[path.value];
    if (alias !== undefined) navigate(alias + query.value, true);
    else if (m === null || m.route.path === "/login") navigate("/", true);
  }, [user, m, path.value]);

  if (user === undefined) {
    // a public page needs nobody, so a slow or hanging first load does
    // not hold the sign-in form back
    if (!needsUser) {
      const View = m.route.view;
      return <View params={m.params} />;
    }
    if (meError.value === null) {
      // a route with a shape of its own (a chat) waits in it already,
      // so the shape does not change when the user lands
      const Shape =
        m !== null && m.route.view.waiting !== PageCodeWaiting
          ? m.route.view.waiting
          : null;
      return (
        <Shell user={undefined} waited={waited}>
          {Shape !== null && m !== null ? (
            <Shape params={m.params} />
          ) : (
            <PageWaiting label="Loading 1ctx" />
          )}
        </Shell>
      );
    }
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
    if (needsUser) return <SignIn />;
    const View = m.route.view;
    return <View params={m.params} />;
  }
  if (m === null || m.route.path === "/login") return null;
  if (m.route.role === "admin" && user.role !== "admin") {
    return (
      <Shell user={user} waited={waited}>
        <p class="error">This page is for admins.</p>
      </Shell>
    );
  }
  const View = m.route.view;
  return (
    <Shell user={user} waited={waited}>
      <View params={m.params} />
    </Shell>
  );
}
