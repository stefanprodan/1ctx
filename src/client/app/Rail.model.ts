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

// the address alone picks the rail's face: a zone's pages are the admin
// face, every other page the working one
export function adminFace(pathname: string): boolean {
  return ZONES.some((z) => onPage(pathname, z.href));
}

// the one link of a zone lit for a path: the longest that holds it, so
// /admin/monitor/storage lights Storage and not the zone at /admin/monitor too
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

// the one link of the admin face lit for a path: the zone or the page
// that holds it, a page's own tab at another address lighting the page
export function zoneLit(pathname: string, zones = ZONES): string | null {
  const targets = new Map<string, string>();
  for (const z of zones) {
    targets.set(z.href, z.href);
    for (const p of z.pages) {
      targets.set(p.href, p.href);
      for (const also of p.also ?? []) targets.set(also, p.href);
    }
  }
  const hit = litPage(pathname, [...targets.keys()]);
  return hit === null ? null : targets.get(hit)!;
}
