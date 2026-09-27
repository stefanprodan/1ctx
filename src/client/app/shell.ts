// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell's state: whether the window is narrow, whether the rail is
// hidden on a wide window (a choice that is kept), and whether it is
// open full screen on a phone (never kept). The width that splits the
// two is the one shell.css and rail.css use. The last page of each
// face, which the band between the faces opens, is kept for the tab's
// life only.

import { effect, signal } from "@preact/signals";
import { adminFace } from "./Rail.model.ts";
import { path, query } from "./router.ts";

export const NARROW = "(max-width: 719px)";
const KEY = "rail";

const stored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "hidden";
  } catch {
    return false;
  }
};

export const narrow = signal(false);
export const railHidden = signal(stored());
export const drawerOpen = signal(false);

export function hideRail(): void {
  railHidden.value = true;
  try {
    localStorage.setItem(KEY, "hidden");
  } catch {}
}

export function showRail(): void {
  railHidden.value = false;
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

export function openDrawer(): void {
  drawerOpen.value = true;
}

export function closeDrawer(): void {
  drawerOpen.value = false;
}

// follows the window; a drawer left open when the window widens is
// closed, so it is not open again the next time the window narrows
export function watchWidth(): void {
  if (typeof matchMedia === "undefined") return;
  const query = matchMedia(NARROW);
  const apply = () => {
    narrow.value = query.matches;
    if (!query.matches) closeDrawer();
  };
  apply();
  query.addEventListener("change", apply);
}

export const lastAdmin = signal("/monitor");
export const lastWork = signal("/");

// follows the address; sign in is no working page to return to
export function watchPages(): () => void {
  return effect(() => {
    const here = path.value + query.value;
    if (adminFace(path.value)) lastAdmin.value = here;
    else if (path.value !== "/login") lastWork.value = here;
  });
}
