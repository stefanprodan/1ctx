// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The root: a public route renders at once; anything else waits for
// the first load of me, with a retry when that load fails; the login
// view when nobody is signed in and the route needs someone; otherwise
// the shell, the rail beside the view.

import { useEffect } from "preact/hooks";
import { loadMe, me, meError } from "../data/me.ts";
import { Login } from "../views/home/Login.tsx";
import { Rail } from "./Rail.tsx";
import { navigate, path } from "./router.ts";
import { match } from "./routes.ts";
import "./shell.css";

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
      <div class="shell">
        <Rail user={user} />
        <main class="shell-main">
          <p class="error">This page is for admins.</p>
        </main>
      </div>
    );
  }
  const View = m.route.view;
  return (
    <div class="shell">
      <Rail user={user} />
      <main class="shell-main">
        <View params={m.params} />
      </main>
    </div>
  );
}
