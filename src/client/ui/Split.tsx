// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A page in two columns: the content, and an aside of cards at its
// right, as a repository page has its About column. Wide screens get
// structure instead of rows stretched across them; under 1100 the
// aside drops below the content.

import type { ComponentChildren } from "preact";
import "./split.css";

export function Split({
  aside,
  children,
}: {
  aside: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <div class="split">
      <div class="split-main">{children}</div>
      <div class="split-aside">{aside}</div>
    </div>
  );
}

// a card in the aside: a label, an optional action at its right, then
// whatever rows or lines the page puts in it
export function AsideCard({
  label,
  action,
  children,
}: {
  label: string;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="split-card">
      <div class="split-card-head">
        <span class="label">{label}</span>
        {action && <span class="split-card-act">{action}</span>}
      </div>
      {children}
    </section>
  );
}
