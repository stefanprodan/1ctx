// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The tab's title from what the page already read: the object's row,
// as Recent reads it, and the project's name from the rail's list, so
// no request is added. An effect over those signals, so a row that
// arrives late or a rename frame changes the tab, not only a new path.

import { effect } from "@preact/signals";
import { adminProject } from "../data/admin-projects.ts";
import { me } from "../data/me.ts";
import { projects } from "../data/projects.ts";
import { projectHere } from "./Rail.model.ts";
import { recentHref, recentPage, recentText } from "./Recent.model.ts";
import { readRow } from "./Recent.state.ts";
import { path } from "./router.ts";
import { type Match, match } from "./routes.ts";
import { signInTitle, tabTitle } from "./Title.model.ts";

// the object's row on its page; a session's only on its own address,
// since /chat and /run each refuse the other origin
function rowName(here: string): { name: string; projectId: string } | null {
  const page = recentPage(here);
  if (page === null) return null;
  const row = readRow(page)?.row;
  if (row === undefined) return null;
  if (page.kind === "session" && recentHref(row) !== here) return null;
  return { name: recentText(row), projectId: row.projectId };
}

// an admin page names its object by the address, but a project by id
function adminName(m: Match): string | null {
  if (m.route.path !== "/admin/access/projects/:id") return null;
  const held = adminProject.value;
  return held?.id === m.params.id ? held.name : null;
}

export function pageTitle(): string {
  const here = path.value;
  const m = match(here);
  if (me.value === null && (m === null || m.route.role !== "public")) {
    return signInTitle();
  }
  if (m === null) return tabTitle(null);
  const admin = m.route.role === "admin";
  if (admin) {
    return tabTitle({
      word: m.route.title(m.params),
      name: adminName(m),
      project: null,
      admin,
    });
  }
  const row = rowName(here);
  const projectId = row?.projectId ?? projectHere(here, null);
  const project =
    projectId === null
      ? null
      : (projects.value?.find((p) => p.id === projectId)?.name ?? null);
  return tabTitle({
    word: m.route.title(m.params),
    name: row?.name ?? null,
    project,
    admin,
  });
}

export function watchTitle(): () => void {
  return effect(() => {
    const title = pageTitle();
    if (document.title !== title) document.title = title;
  });
}
