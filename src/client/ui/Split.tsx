// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A page in two columns: the content, and a quiet aside at its right
// with a few sections of plain lines, as a repository page has its
// About column. Wide screens get structure instead of rows stretched
// across them; under 1100, a tablet or a phone, the aside is hidden
// and the content has the width.

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

// a section of the aside: a label, an optional action at its right,
// then the lines the page puts under it
export function AsideSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="split-section">
      <div class="split-section-head">
        <span class="label">{label}</span>
        {action && <span class="split-section-act">{action}</span>}
      </div>
      {children}
    </section>
  );
}
