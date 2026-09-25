// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A settings section: a title and a line on the left, its form on the
// right, a rule above; one column under 720. A page stacks them.

import type { ComponentChildren, Ref } from "preact";
import "./section.css";

export function Section({
  title,
  text,
  off,
  children,
}: {
  title: string;
  text: string;
  // what the section sets does nothing now: its form is faded, and the
  // view disables the fields
  off?: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class={`section${off ? " section-off" : ""}`}>
      <div class="section-head">
        <h2 class="section-title">{title}</h2>
        <p class="section-text">{text}</p>
      </div>
      {children}
    </section>
  );
}

// the form beside a section's head: its fields down one column; the ref
// lets a refusal move the focus to the field it names
export function SectionForm({
  onSubmit,
  formRef,
  children,
}: {
  onSubmit: (event: Event) => void;
  formRef?: Ref<HTMLFormElement>;
  children: ComponentChildren;
}) {
  return (
    <form class="section-form" ref={formRef} onSubmit={onSubmit}>
      {children}
    </form>
  );
}
