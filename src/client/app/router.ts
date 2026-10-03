// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Where the page is: the pathname and the query as signals, navigate()
// with pushState, and the back button. It knows no route and no view,
// so a view may import it to navigate without a cycle through the table.

import { batch, signal } from "@preact/signals";

const here = () =>
  typeof location === "undefined"
    ? { pathname: "/", search: "" }
    : { pathname: location.pathname, search: location.search };

export const path = signal(here().pathname);
export const query = signal(here().search);

// a late answer compares it before it navigates
export const address = (): string => path.value + query.value;

// "to" is a path with an optional query; the pathname and the query
// land in their own signals so a route matches on the pathname alone
export function navigate(to: string, replace = false): void {
  const url = new URL(to, location.origin);
  if (url.pathname === path.value && url.search === query.value) return;
  const target = url.pathname + url.search;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
  // one navigation is one change: an effect over both signals must not
  // see the new path with the old query in between
  batch(() => {
    path.value = url.pathname;
    query.value = url.search;
  });
}

export type Link = {
  origin: string;
  pathname: string;
  download: boolean;
  // target="_blank", which rendered markdown gives every link
  blank: boolean;
};

// a same-origin link opens in place unless it is a download or asks for
// a new tab. An installed app has no tabs: a new one would leave it
// for the browser, so there a page of the app opens in place even from
// a rendered reply, and only the API, another origin, mailto and a
// download leave
export function inApp(
  link: Link,
  origin: string,
  standalone: boolean,
): boolean {
  if (link.origin !== origin || link.download) return false;
  if (!link.blank) return true;
  return (
    standalone && link.pathname !== "/api" && !link.pathname.startsWith("/api/")
  );
}

const STANDALONE = "(display-mode: standalone)";

// the click on any in-page link goes through navigate, so the page
// never reloads
function onLinkClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as HTMLElement).closest("a");
  if (anchor === null) return;
  const link = {
    origin: anchor.origin,
    pathname: anchor.pathname,
    download: anchor.hasAttribute("download"),
    blank: anchor.target === "_blank",
  };
  if (!inApp(link, location.origin, matchMedia(STANDALONE).matches)) return;
  event.preventDefault();
  navigate(anchor.pathname + anchor.search);
}

export function boot(): void {
  window.addEventListener("popstate", () => {
    batch(() => {
      path.value = location.pathname;
      query.value = location.search;
    });
  });
  document.addEventListener("click", onLinkClick);
}
