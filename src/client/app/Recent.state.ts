// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The rail's Recent list: a page is recorded once the row it shows is
// read, from what the page already loaded, so no request is added. The
// list is this browser's, one per user in localStorage, so it stays
// when another user signs in here. Storage can be absent or full, so
// every access is guarded; a failed write keeps the list for the tab.
// Its rows follow the socket's frames and the page's not found, and
// every tab of the user takes the list another one wrote. A row's
// live status is never stored: a reload draws every row plain until a
// visit or a frame gives it, so a run never shows running after it
// finished while the tab was closed.

import { effect, signal, untracked } from "@preact/signals";
import type { SocketEvent } from "../../shared/socket.ts";
import {
  automationError,
  automationProject,
  automations,
} from "../data/automations.ts";
import { taskError, taskPage } from "../data/external-task.ts";
import { docFileOf } from "../data/knowledge-file.ts";
import { me } from "../data/me.ts";
import { session, sessionError } from "../data/sessions.ts";
import { onSocketEvent } from "../data/socket.ts";
import {
  automationRecent,
  automationStatus,
  dropRecent,
  fileRecent,
  keepRecent,
  notFound,
  pruneStatus,
  pushRecent,
  type RecentPage,
  type RecentRow,
  type RecentStatus,
  type RecentStatuses,
  readRecent,
  recentFrame,
  recentHref,
  recentKey,
  recentPage,
  reopenStatus,
  sameRow,
  sessionRecent,
  sessionStatus,
  statusFrame,
  taskRecent,
  taskStatus,
  visitKey,
  withStatus,
} from "./Recent.model.ts";
import { path } from "./router.ts";

export const recent = signal<RecentRow[]>([]);

// each held row's live status, in memory only
export const recentStatus = signal<RecentStatuses>({});

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
  return stored(userId) ?? [];
}

// the list as the user's tabs last wrote it; null when nothing was
// written or there is no storage, so the tab's own list stands
function stored(userId: string): RecentRow[] | null {
  try {
    const raw = localStorage.getItem(recentStoreKey(userId));
    return raw === null ? null : readRecent(raw);
  } catch {
    return null;
  }
}

function save(userId: string, list: RecentRow[]): void {
  try {
    localStorage.setItem(recentStoreKey(userId), JSON.stringify(list));
  } catch {
    // a private window or a full storage: the tab keeps the list
  }
}

type Read = { row: RecentRow; status: RecentStatus | null };

// the row of the object on screen once its page has read it, and its
// status from the same read, null before; only the signals of that
// page are read, so no other page's loads run the watcher
export function readRow(page: RecentPage): Read | null {
  switch (page.kind) {
    case "session": {
      const s = session.value?.session;
      if (s?.id !== page.id) return null;
      // a run's title is its automation's name when it ran; the row
      // takes the name now, which a rename frame may have brought
      const name =
        s.origin === "automation" && s.automationId !== null
          ? automations.value?.find((a) => a.id === s.automationId)?.name
          : undefined;
      return {
        row: sessionRecent(name === undefined ? s : { ...s, title: name }),
        status: sessionStatus(s),
      };
    }
    case "automation": {
      // the page's own read names the project, then the list holds it
      if (automationProject.value?.id !== page.id) return null;
      const held = automations.value?.find((a) => a.id === page.id);
      return held === undefined
        ? null
        : { row: automationRecent(held), status: automationStatus(held) };
    }
    case "task": {
      const t = taskPage.value;
      return t?.id === page.id
        ? { row: taskRecent(t.detail.task), status: taskStatus(t.detail.task) }
        : null;
    }
    case "file": {
      const doc = docFileOf(page.id);
      return doc.state === "done" && doc.deleted === null
        ? { row: fileRecent(doc.file), status: null }
        : null;
    }
  }
}

function setStatuses(next: RecentStatuses): void {
  if (next !== recentStatus.peek()) recentStatus.value = next;
}

const sameList = (a: RecentRow[], b: RecentRow[]) =>
  a.length === b.length && a.every((r, i) => sameRow(r, b[i]));

// the failure the page on screen shows. A chat's, an automation's and
// a task's are one signal for whichever page is open, so the watcher
// counts one only once it changed in the visit; a file's is its own
function failureOf(page: RecentPage): unknown {
  switch (page.kind) {
    case "session":
      return sessionError.value;
    case "automation":
      return automationError.value;
    case "task":
      return taskError.value;
    case "file":
      return docFileOf(page.id);
  }
}

function isGone(page: RecentPage, failure: unknown): boolean {
  if (page.kind !== "file") {
    return notFound(failure as Parameters<typeof notFound>[0]);
  }
  const doc = failure as ReturnType<typeof docFileOf>;
  return (
    doc.state === "missing" || (doc.state === "done" && doc.deleted !== null)
  );
}

// a value a failure never holds, for a visit whose first one changed
const CHANGED = Symbol("changed");

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
  // the failure on screen when the visit began, left by the page before
  let stale: unknown = CHANGED;
  // a frame of a project the user sees, whatever page is open
  const offSocket = onSocketEvent((ev: SocketEvent) => {
    if (owner === null) return;
    // every open of the socket says hello
    if (ev.type === "hello") {
      setStatuses(reopenStatus(recentStatus.peek(), recentPage(path.peek())));
      return;
    }
    // the stored list, not the held one: another tab may have written
    // since, and its storage event may not have arrived yet
    const list = stored(owner) ?? recent.peek();
    const next = recentFrame(list, ev);
    if (next !== list) {
      recent.value = next;
      save(owner, next);
    }
    setStatuses(statusFrame(recentStatus.peek(), recent.peek(), ev));
  });
  // another tab wrote the list: taken, never written back, so two tabs
  // never answer each other. A cleared storage has no key
  const onStorage = (ev: Event) => {
    const { key, newValue } = ev as StorageEvent;
    if (owner === null) return;
    if (key !== null && key !== recentStoreKey(owner)) return;
    const next = readRecent(key === null ? null : newValue);
    if (!sameList(next, recent.peek())) recent.value = next;
  };
  globalThis.addEventListener?.("storage", onStorage);
  // a status leaves with its row, however the row went
  const disposePrune = effect(() => {
    const list = recent.value;
    setStatuses(pruneStatus(recentStatus.peek(), list));
  });
  const dispose = effect(() => {
    const user = me.value;
    if (owner !== (user?.id ?? null)) {
      owner = user?.id ?? null;
      seen = null;
      visit = null;
      picked = null;
      recentStatus.value = {};
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
        stale = page === null ? CHANGED : untracked(() => failureOf(page));
      } else if (at !== null && pick === at) {
        // from a tab of the visit that records nothing, its edit page
        fromRecent = true;
      }
    }
    if (page === null || !page.record) return;
    const failure = failureOf(page);
    if (page.kind === "file" || failure !== stale) {
      stale = CHANGED;
      if (isGone(page, failure)) {
        const list = recent.peek();
        const next = dropRecent(list, page);
        if (next !== list) {
          recent.value = next;
          save(user.id, next);
        }
        return;
      }
    }
    const read = readRow(page);
    if (read === null) return;
    const { row, status } = read;
    const inPlace = placed || fromRecent;
    const first = !placed;
    placed = true;
    // peeked, so the write below never runs this again
    const list = recent.peek();
    // only a visit's first read adds a row: one gone since was dropped
    // or pushed off, here or by another tab, and never comes back on top
    const key = recentKey(row);
    if (!first && !list.some((r) => recentKey(r) === key)) return;
    const next = inPlace ? keepRecent(list, row) : pushRecent(list, row);
    if (!sameList(next, list)) {
      recent.value = next;
      save(user.id, next);
    }
    if (status !== null) {
      setStatuses(withStatus(recentStatus.peek(), row, status));
    }
  });
  return () => {
    dispose();
    disposePrune();
    offSocket();
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
