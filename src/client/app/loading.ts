// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The route table owns loading. A view never starts a fetch: each
// route entry names what it needs, and this starts that load when the
// path, the query or the signed-in user changes, ahead of the
// re-render, since a signal effect runs before Preact schedules one.
// The rail's own need, the project list, loads here once per signed-in
// user. An entity module keeps its own guards against an answer that
// is no longer wanted; this only decides when a load starts. reload()
// runs the current route's load again, for the socket to call when it
// learns the entity on screen changed.

import { effect } from "@preact/signals";
import { me } from "../data/me.ts";
import { loadProjects } from "../data/projects.ts";
import { path, query } from "./router.ts";
import { match, ROUTES, type Route } from "./routes.ts";

// module state rather than a return value, so reload() can be imported
// by whoever learns of a change without holding the loader; the token
// says which startLoading() set it, so a disposed one cannot clear
// another's
let current: { run: () => Promise<void>; owner: object } | null = null;

export function startLoading(routes: Route[] = ROUTES): () => void {
  const owner = {};
  let last = { user: "", pathname: "", search: "" };
  const dispose = effect(() => {
    // the user's id, role and password state, not the row: a profile
    // save replaces the row and must not reload the page's entities,
    // while a role change may open an admin page that has not loaded,
    // and a password change opens everything
    const row = me.value;
    const user = row
      ? `${row.id} ${row.role} ${row.mustChangePassword ? "locked" : ""}`
      : "";
    const pathname = path.value;
    const search = query.value;
    if (
      user === last.user &&
      pathname === last.pathname &&
      search === last.search
    ) {
      return;
    }
    const newUser = user !== last.user;
    last = { user, pathname, search };
    current = null;
    if (row === null || row === undefined) return;
    const m = match(pathname, routes);
    // the server refuses every other route until the password changes
    if (row.mustChangePassword && m?.route.path !== "/profile") return;
    if (newUser && !row.mustChangePassword) void loadProjects();
    if (m === null || m.route.load === undefined) return;
    if (m.route.role === "admin" && row.role !== "admin") return;
    const load = m.route.load;
    const run = async () => {
      // a load reports its failure through its entity; one that throws
      // instead, before or after its promise, is a bug in it, reported
      // and not left as an unhandled rejection
      try {
        await load(m.params, new URLSearchParams(search));
      } catch (err) {
        console.error(`load for ${m.route.path} failed: ${String(err)}`);
      }
    };
    current = { run, owner };
    void run();
  });
  return () => {
    if (current?.owner === owner) current = null;
    dispose();
  };
}

export function reload(): Promise<void> {
  return current === null ? Promise.resolve() : current.run();
}
