// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SessionDetail } from "../../shared/contracts/session.ts";

// the project a page is in: its own pages, the chat's, or the
// automation's, which only its row names
export function projectHere(
  pathname: string,
  chat: SessionDetail | null,
  automation: { id: string; projectId: string } | null = null,
): string | null {
  const page = /^\/projects\/([^/]+)(\/|$)/.exec(pathname);
  if (page !== null) return decodeURIComponent(page[1]);
  const open = /^\/chat\/([^/]+)$/.exec(pathname);
  if (open !== null && chat?.session.id === decodeURIComponent(open[1])) {
    return chat.session.projectId;
  }
  const task = /^\/automations\/([^/]+)(\/edit|\/memory)?$/.exec(pathname);
  if (task !== null && automation?.id === decodeURIComponent(task[1])) {
    return automation.projectId;
  }
  return null;
}

// a rail link is lit on its page and on the pages under it, a tab
export function onPage(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

// the one page of a group lit for a path: the longest that holds it, so
// /admin/storage lights Storage and not the Overview at /admin too
export function litPage(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    if (
      onPage(pathname, href) &&
      (best === null || href.length > best.length)
    ) {
      best = href;
    }
  }
  return best;
}
