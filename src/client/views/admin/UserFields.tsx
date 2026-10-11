// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { shapedInput } from "../../lib/names.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { ZoneSelect } from "../../ui/ZoneSelect.tsx";

export type Who = {
  username: string;
  fullName: string;
  email: string;
  tz: string;
};

function Text({
  label,
  name,
  value,
  type,
  hint,
  save,
  onInput,
}: {
  label: string;
  name: keyof Who;
  value: string;
  type?: "email";
  hint?: string;
  save: Save;
  onInput: (e: Event) => void;
}) {
  const invalid = save.fieldError(name) !== null;
  return (
    <label class="field">
      <span class="label label-required">{label}</span>
      <input
        name={name}
        // preact types an input by its type, so a union type fits no branch
        {...(type === "email"
          ? { type: "email" as const }
          : { type: "text" as const })}
        aria-required="true"
        aria-invalid={invalid || undefined}
        autocomplete="off"
        spellcheck={false}
        disabled={save.busy}
        value={value}
        onInput={onInput}
      />
      {hint !== undefined && !invalid ? (
        <span class="hint">{hint}</span>
      ) : (
        <FieldError save={save} field={name} />
      )}
    </label>
  );
}

export function UserFields({
  who,
  save,
  emailHint,
  onChange,
  children,
}: {
  who: Who;
  save: Save;
  emailHint?: string;
  onChange: (patch: Partial<Who>) => void;
  children?: ComponentChildren;
}) {
  return (
    <div class="pair">
      <Text
        label="Username"
        name="username"
        value={who.username}
        save={save}
        onInput={(e) => onChange({ username: shapedInput(e) })}
      />
      <Text
        label="Full name"
        name="fullName"
        value={who.fullName}
        save={save}
        onInput={(e) =>
          onChange({ fullName: (e.currentTarget as HTMLInputElement).value })
        }
      />
      <Text
        label="Email"
        name="email"
        type="email"
        value={who.email}
        hint={emailHint}
        save={save}
        onInput={(e) =>
          onChange({ email: (e.currentTarget as HTMLInputElement).value })
        }
      />
      <div class="field">
        <span class="label label-required">Time zone</span>
        <ZoneSelect
          name="tz"
          value={who.tz}
          invalid={save.fieldError("tz") !== null}
          disabled={save.busy}
          placeholder="Pick a zone"
          onChange={(tz) => onChange({ tz })}
        />
        <FieldError save={save} field="tz" />
      </div>
      {children}
    </div>
  );
}
