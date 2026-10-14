// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail's Recent list: a page is recorded once the row it shows is
// read, from what the page already loaded, so no request is added. The
// list is this browser's, one per user in localStorage, so it stays
// when another user signs in here. Storage can be absent or full, so
// every access is guarded; a failed write keeps the list for the tab.

import { effect, signal } from "@preact/signals";
import { automationProject, automations } from "../data/automations.ts";
import { taskPage } from "../data/external-task.ts";
import { docFileOf } from "../data/knowledge-file.ts";
import { me } from "../data/me.ts";
import { session } from "../data/sessions.ts";
import {
  automationRecent,
  fileRecent,
  keepRecent,
  pushRecent,
  type RecentPage,
  type RecentRow,
  readRecent,
  recentHref,
  recentPage,
  sameRow,
  sessionRecent,
  taskRecent,
  visitKey,
} from "./Recent.model.ts";
import { path } from "./router.ts";

export const recent = signal<RecentRow[]>([]);

export const recentStoreKey = (userId: string) => `recent:${userId}`;

// the visit a Recent row was clicked for, until the next navigation
let picked: string | null = null;

// a click that opens the row's page here, so the list keeps its order;
// a click for a new tab or a window opens nothing here, and a click on
// the page on screen opens nothing at all
export function pickRecent(
  row: RecentRow,
  click: Pick<
    MouseEvent,
    "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
): void {
  if (
    click.button !== 0 ||
    click.metaKey ||
    click.ctrlKey ||
    click.shiftKey ||
    click.altKey
  ) {
    return;
  }
  const page = recentPage(recentHref(row));
  const here = recentPage(path.peek());
  const to = page === null ? null : visitKey(page);
  // an edit page records nothing, so its row's click still opens the
  // automation from Recent
  picked = here?.record === true && visitKey(here) === to ? null : to;
}

function load(userId: string): RecentRow[] {
  try {
    return readRecent(localStorage.getItem(recentStoreKey(userId)));
  } catch {
    return [];
  }
}

function save(userId: string, list: RecentRow[]): void {
  try {
    localStorage.setItem(recentStoreKey(userId), JSON.stringify(list));
  } catch {
    // a private window or a full storage: the tab keeps the list
  }
}

// the row of the object on screen once its page has read it, null
// before; only the signals of that page are read, so no other page's
// loads run the watcher
function readRow(page: RecentPage): RecentRow | null {
  switch (page.kind) {
    case "session": {
      const s = session.value?.session;
      return s?.id === page.id ? sessionRecent(s) : null;
    }
    case "automation": {
      // the page's own read names the project, then the list holds it
      if (automationProject.value?.id !== page.id) return null;
      const row = automations.value?.find((a) => a.id === page.id);
      return row === undefined ? null : automationRecent(row);
    }
    case "task": {
      const t = taskPage.value;
      return t?.id === page.id ? taskRecent(t.detail.task) : null;
    }
    case "file": {
      const doc = docFileOf(page.id);
      return doc.state === "done" && doc.deleted === null
        ? fileRecent(doc.file)
        : null;
    }
  }
}

export function watchRecent(): () => void {
  let owner: string | null = null;
  // the address last seen, the object on screen, whether its row was
  // placed in this visit and whether the visit came from a Recent row:
  // a page's rows arrive in steps, and only the first read of a visit
  // opened another way moves its row to the top
  let seen: string | null = null;
  let visit: string | null = null;
  let placed = false;
  let fromRecent = false;
  return effect(() => {
    const user = me.value;
    if (owner !== (user?.id ?? null)) {
      owner = user?.id ?? null;
      seen = null;
      visit = null;
      picked = null;
      recent.value = owner === null ? [] : load(owner);
    }
    if (user === null || user === undefined) return;
    const page = recentPage(path.value);
    if (path.value !== seen) {
      seen = path.value;
      // a pick is for the navigation its click makes, never a later one
      const pick = picked;
      picked = null;
      const at = page === null ? null : visitKey(page);
      if (at !== visit) {
        visit = at;
        placed = false;
        fromRecent = at !== null && pick === at;
      } else if (at !== null && pick === at) {
        // from a tab of the visit that records nothing, its edit page
        fromRecent = true;
      }
    }
    if (page === null || !page.record) return;
    const row = readRow(page);
    if (row === null) return;
    const inPlace = placed || fromRecent;
    placed = true;
    // peeked, so the write below never runs this again
    const list = recent.peek();
    const next = inPlace ? keepRecent(list, row) : pushRecent(list, row);
    if (
      next.length === list.length &&
      next.every((r, i) => sameRow(r, list[i]))
    ) {
      return;
    }
    recent.value = next;
    save(user.id, next);
  });
}
