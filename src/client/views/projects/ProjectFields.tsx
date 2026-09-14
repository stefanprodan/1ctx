// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's name and description, as an admin sets them on a team and
// a user on their own project. The description has room to read a few
// lines and is one line on the wire.

import { MAX_DESCRIPTION } from "../../../shared/words.ts";

const LINE_BREAKS = /[\n\r\v\f\u0085\u2028\u2029]+/g;

const withOwner = (owner?: string) => `field${owner ? ` ${owner}` : ""}`;

export function NameField({
  value,
  placeholder,
  disabled,
  class: owner,
  onInput,
}: {
  value: string;
  placeholder: string;
  disabled?: boolean;
  class?: string;
  onInput: (value: string) => void;
}) {
  return (
    <label class={withOwner(owner)}>
      <span class="label">Name</span>
      <input
        name="name"
        autocomplete="off"
        spellcheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onInput={(event) =>
          onInput((event.currentTarget as HTMLInputElement).value)
        }
      />
      <span class="hint">Lowercase letters, digits and dashes.</span>
    </label>
  );
}

export function DescriptionField({
  value,
  disabled,
  hint = true,
  class: owner,
  onInput,
}: {
  value: string;
  disabled?: boolean;
  // off where the section's text already says it
  hint?: boolean;
  class?: string;
  onInput: (value: string) => void;
}) {
  return (
    <label class={withOwner(owner)}>
      <span class="label">Description</span>
      <textarea
        name="description"
        rows={3}
        maxLength={MAX_DESCRIPTION}
        placeholder="What the work here is about"
        disabled={disabled}
        value={value}
        onInput={(event) => {
          const box = event.currentTarget as HTMLTextAreaElement;
          box.value = box.value.replace(LINE_BREAKS, " ");
          onInput(box.value);
        }}
      />
      {hint && (
        <span class="hint">What agents should know about this project.</span>
      )}
    </label>
  );
}
