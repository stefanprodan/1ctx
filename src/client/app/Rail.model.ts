// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SessionDetail } from "../../shared/contracts/session.ts";
import { ZONES } from "./zones.ts";

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

export function adminFace(pathname: string): boolean {
  return onPage(pathname, "/admin");
}

// the longest that holds the path, so /admin/monitor/storage lights
// Storage and not /admin/monitor too
function litPage(pathname: string, hrefs: string[]): string | null {
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

const TARGETS = new Map<string, string>();
for (const z of ZONES) {
  TARGETS.set(z.href, z.href);
  for (const p of z.pages) {
    TARGETS.set(p.href, p.href);
    for (const also of p.also ?? []) TARGETS.set(also, p.href);
  }
}
const HREFS = [...TARGETS.keys()];

export function zoneLit(pathname: string): string | null {
  const hit = litPage(pathname, HREFS);
  return hit === null ? null : TARGETS.get(hit)!;
}

// a rail entry is lit on its own address; the Directory also on its
// Agents tab and on the user and agent pages it lists
export function navLit(pathname: string, href: string): boolean {
  if (href !== "/directory") return pathname === href;
  return (
    onPage(pathname, href) ||
    pathname.startsWith("/users/") ||
    pathname.startsWith("/agents/")
  );
}
