// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A row of tabs under a page head, or as the head of the card they
// open: each is a link, so the tab is the address and back, reload and
// a shared link keep it.

import "./tabs.css";

// count is the number beside the label, left out while it is unknown
export type Tab = { label: string; href: string; count?: number };

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
  return (
    <nav class={`tabs${head ? " tabs-head" : ""}`} aria-label="Sections">
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
