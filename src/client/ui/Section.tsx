// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A settings section: a title and a line on the left, its form on the
// right, a rule above; one column under 720. A page stacks them.

import type { ComponentChildren, Ref } from "preact";
import "./foot.css";
import "./section.css";
import { Bone } from "./Bones.tsx";
import { FieldBone, type FieldBones } from "./SettingWaiting.tsx";

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

export type SectionBones = {
  title: string;
  // null for words the answer brings: a bone in their place
  text: string | null;
  fields?: readonly FieldBones[];
  // the fields land with no label over them
  bare?: boolean;
  // the form's own bones, for a field whose landed parts no field
  // bone draws (a seg over its box, a box with a bar), in place of the
  // fields
  body?: ComponentChildren;
  // the form's Save under the fields
  foot?: boolean;
};

// a page of sections while its first answer loads: each head in its
// own words, a bone for each field, in the landed form's class
export function SectionsWaiting({
  label,
  sections,
  lead,
  class: owner,
}: {
  // what is loading, for a screen reader: "Loading the form"
  label: string;
  sections: readonly SectionBones[];
  // what the landed page opens with over its sections: who it is about
  lead?: ComponentChildren;
  class: string;
}) {
  return (
    <div class={`${owner} bones-wait`} role="status" aria-label={label}>
      {lead}
      {sections.map((s, i) => (
        <section key={s.title} class="section" aria-hidden="true">
          <div class="section-head">
            <h2 class="section-title">{s.title}</h2>
            {s.text === null ? (
              <p class="section-text bones-lines-line">
                <Bone kind="line" at={i * 4} width={70} />
              </p>
            ) : (
              <p class="section-text">{s.text}</p>
            )}
          </div>
          <div class="section-form">
            {s.body ?? (
              <div class="pair">
                {(s.fields ?? []).map((kind, j) => (
                  <FieldBone
                    key={j}
                    kind={kind}
                    at={i * 4 + j * 2}
                    bare={s.bare}
                  />
                ))}
              </div>
            )}
            {s.foot && (
              <div class="foot">
                <Bone kind="button" at={i * 4 + 3} />
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
