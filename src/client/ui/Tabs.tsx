// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A row of tabs under a page head: each is a link, so the tab is the
// address and back, reload and a shared link keep it.

import "./tabs.css";

// count is the number beside the label, left out while it is unknown
export type Tab = { label: string; href: string; count?: number };

export function Tabs({ tabs, active }: { tabs: Tab[]; active: string }) {
  return (
    <nav class="tabs" aria-label="Sections">
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
