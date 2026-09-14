// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A settings section: a title and a line on the left, its form on the
// right, a rule above; one column under 720. A page stacks them.

import type { ComponentChildren } from "preact";
import "./section.css";

export function Section({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: ComponentChildren;
}) {
  return (
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">{title}</h2>
        <p class="section-text">{text}</p>
      </div>
      {children}
    </section>
  );
}

// the form beside a section's head: its fields down one column
export function SectionForm({
  onSubmit,
  children,
}: {
  onSubmit: (event: Event) => void;
  children: ComponentChildren;
}) {
  return (
    <form class="section-form" onSubmit={onSubmit}>
      {children}
    </form>
  );
}
