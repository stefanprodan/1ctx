// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell's state: whether the window is narrow, whether the rail is
// a drawer, whether it is hidden on a wide window (a choice that is
// kept), and whether the drawer is open (never kept). The queries are
// the ones the stylesheets use.

import { effect, signal } from "@preact/signals";
import { MONITOR_HREF } from "../lib/hrefs.ts";
import { frameOf } from "../lib/viewport.ts";
import { adminFace } from "./Rail.model.ts";
import { address, path } from "./router.ts";

export const NARROW = "(max-width: 719px)";
// a phone on its side is wide but too short for a rail beside the view;
// the tallest phone is 440 on its side, the smallest tablet 744. A short
// desktop window keeps its rail
export const DRAWER = `${NARROW}, (max-height: 500px) and (pointer: coarse)`;
const KEY = "rail";

const stored = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "hidden";
  } catch {
    return false;
  }
};

export const narrow = signal(false);
export const railDrawer = signal(false);
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

// follows the window; a drawer left open when the rail stops being one
// is closed, so it is not open again the next time it becomes one
export function watchScreen(): void {
  if (typeof matchMedia === "undefined") return;
  const width = matchMedia(NARROW);
  const drawer = matchMedia(DRAWER);
  const apply = () => {
    narrow.value = width.matches;
    railDrawer.value = drawer.matches;
    if (!drawer.matches) closeDrawer();
  };
  apply();
  width.addEventListener("change", apply);
  drawer.addEventListener("change", apply);
}

// the shell follows the visible area while a phone's keyboard is up; a
// page without the shell, the login, keeps the browser's own scroll
export function watchViewport(): void {
  if (typeof window === "undefined" || !window.visualViewport) return;
  const view = window.visualViewport;
  const root = document.documentElement;
  const set = (name: string, px: number | null) => {
    if (px === null || px === 0) root.style.removeProperty(name);
    else root.style.setProperty(name, `${px}px`);
  };
  const apply = () => {
    const frame = document.querySelector(".shell")
      ? frameOf(root.clientHeight, view)
      : { height: null, top: 0 };
    set("--shell-height", frame.height);
    // the shell moves to the visible area at once, and the page goes
    // back to its top; where the browser keeps the visual viewport
    // lower, the offset stays and the shell with it
    set("--shell-top", frame.top);
    if (frame.top > 0) window.scrollTo(0, 0);
  };
  view.addEventListener("resize", apply);
  view.addEventListener("scroll", apply);
}

// where a fixed panel's frame starts in the window: the shell's corner
// while watchViewport moves it, since a transform holds fixed children
export function fixedFrame(el: Element): { top: number; left: number } {
  const shell = el.closest(".shell");
  if (shell === null || getComputedStyle(shell).transform === "none") {
    return { top: 0, left: 0 };
  }
  const box = shell.getBoundingClientRect();
  return { top: box.top, left: box.left };
}

export const lastAdmin = signal(MONITOR_HREF);
export const lastWork = signal("/");

// an address with no page (an alias, a typo) is none to open again
export function watchPages(hasPage: (pathname: string) => boolean): () => void {
  return effect(() => {
    if (!hasPage(path.value)) return;
    const here = address();
    if (adminFace(path.value)) lastAdmin.value = here;
    else if (path.value !== "/login") lastWork.value = here;
  });
}
