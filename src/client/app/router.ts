// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where the page is: the pathname and the query as signals, navigate()
// with pushState, and the back button. It knows no route and no view,
// so a view may import it to navigate without a cycle through the table.

import { signal } from "@preact/signals";

const here = () =>
  typeof location === "undefined"
    ? { pathname: "/", search: "" }
    : { pathname: location.pathname, search: location.search };

export const path = signal(here().pathname);
export const query = signal(here().search);

// "to" is a path with an optional query; the pathname and the query
// land in their own signals so a route matches on the pathname alone
export function navigate(to: string, replace = false): void {
  const url = new URL(to, location.origin);
  if (url.pathname === path.value && url.search === query.value) return;
  const target = url.pathname + url.search;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
  path.value = url.pathname;
  query.value = url.search;
}

// the click on any in-page link goes through navigate, so the page
// never reloads
export function onLinkClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as HTMLElement).closest("a");
  if (anchor === null || anchor.origin !== location.origin) return;
  if (anchor.hasAttribute("download") || anchor.target === "_blank") return;
  event.preventDefault();
  navigate(anchor.pathname + anchor.search);
}

export function boot(): void {
  window.addEventListener("popstate", () => {
    path.value = location.pathname;
    query.value = location.search;
  });
  document.addEventListener("click", onLinkClick);
}
