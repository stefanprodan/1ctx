// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A row of tabs under a page head, or as the head of the card they
// open: each is a link, so the tab is the address and back, reload and
// a shared link keep it.

import { useSignal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import { onResize } from "../lib/resize.ts";
import "./tabs.css";

// count is the number beside the label, left out while it is unknown
export type Tab = { label: string; href: string; count?: number };

// the width of the fade at a row's hidden edge, as in tabs.css
export const FADE = 32;

// the scroll that shows a tab whole and clear of the fades in a row
// scrolled to `scroll`, the row's own when it already does; the browser
// clamps a scroll past the end
export function scrollTo(
  scroll: number,
  width: number,
  tab: { left: number; width: number },
): number {
  if (tab.left - FADE < scroll) return Math.max(0, tab.left - FADE);
  if (tab.left + tab.width + FADE > scroll + width) {
    return tab.left + tab.width + FADE - width;
  }
  return scroll;
}

export function Tabs({
  tabs,
  active,
  head,
}: {
  tabs: Tab[];
  active: string;
  // in a card's head, on its rule rather than a hairline of their own
  head?: boolean;
}) {
  const row = useRef<HTMLElement>(null);
  // a phone's row hides tabs past an edge: a fade says which side
  const before = useSignal(false);
  const after = useSignal(false);
  useLayoutEffect(() => {
    const node = row.current;
    if (node === null) return;
    const on = node.querySelector<HTMLElement>(".tabs-tab-on");
    if (on !== null) {
      node.scrollLeft = scrollTo(node.scrollLeft, node.clientWidth, {
        left: on.offsetLeft - node.offsetLeft,
        width: on.offsetWidth,
      });
    }
    const measure = () => {
      before.value = node.scrollLeft > 1;
      after.value = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    };
    measure();
    // a web font that lands after the first paint widens the tabs, not
    // the row the observer watches
    void document.fonts?.ready.then(measure);
    node.addEventListener("scroll", measure, { passive: true });
    const stop = onResize(node, measure);
    return () => {
      node.removeEventListener("scroll", measure);
      stop();
    };
  }, [active, tabs.length]);
  const classes = [
    "tabs",
    head && "tabs-head",
    before.value && "tabs-before",
    after.value && "tabs-after",
  ].filter(Boolean);
  return (
    <nav ref={row} class={classes.join(" ")} aria-label="Sections">
      {tabs.map((tab) => (
        <a
          key={tab.href}
          class={`tabs-tab${tab.href === active ? " tabs-tab-on" : ""}`}
          href={tab.href}
          aria-current={tab.href === active ? "page" : undefined}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span class="tabs-count">{tab.count}</span>
          )}
        </a>
      ))}
    </nav>
  );
}
