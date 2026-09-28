// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A credential's fields, drawn alike by New credential and by the cards
// of its page: a text field with its hint or its refusal, the key file,
// the methods in one line and the team projects as boxes.

import {
  HTTP_METHODS,
  type HttpMethod,
} from "../../../shared/contracts/credential.ts";
import { credentialKeys } from "../../data/credentials.ts";
import { toggledId } from "../../lib/ids.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { RowsCheck, RowsLine, RowsTitle } from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import { keyOptions, toggledMethod } from "./Credentials.model.ts";
import "./credentials.css";

export function TextField({
  label,
  name,
  value,
  placeholder,
  hint,
  required,
  save,
  wide,
  onInput,
}: {
  label: string;
  name: string;
  value: string;
  placeholder: string;
  hint?: string;
  required?: boolean;
  save: Save;
  wide?: boolean;
  onInput: (value: string) => void;
}) {
  const invalid = save.fieldError(name) !== null;
  return (
    <label class={`field${wide ? " pair-wide" : ""}`}>
      <span class={`label${required ? " label-required" : ""}`}>{label}</span>
      <input
        name={name}
        class="credentials-mono"
        aria-required={required ? "true" : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        disabled={save.busy}
        value={value}
        onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      />
      {invalid ? (
        <FieldError save={save} field={name} />
      ) : (
        hint && <span class="hint">{hint}</span>
      )}
    </label>
  );
}

export function KeyField({
  value,
  hint,
  save,
  bare,
  onChange,
}: {
  value: string;
  hint: string;
  save: Save;
  // under a card titled Key the label would say it twice
  bare?: boolean;
  onChange: (keyName: string) => void;
}) {
  const invalid = save.fieldError("keyName") !== null;
  return (
    <div class="field">
      {!bare && <span class="label label-required">Key</span>}
      <Select
        label="Key"
        name="keyName"
        mono
        value={value}
        placeholder="Pick a key"
        options={keyOptions(credentialKeys.value, value)}
        disabled={save.busy}
        invalid={invalid}
        onChange={onChange}
      />
      {invalid ? (
        <FieldError save={save} field="keyName" />
      ) : (
        <span class="hint">{hint}</span>
      )}
    </div>
  );
}

export function MethodsField({
  value,
  save,
  label,
  onChange,
}: {
  value: HttpMethod[];
  save: Save;
  // a card that names them in its title leaves the label out
  label?: string;
  onChange: (methods: HttpMethod[]) => void;
}) {
  return (
    <div class="field pair-wide">
      {label !== undefined && <span class="label">{label}</span>}
      <div class="credentials-methods">
        {HTTP_METHODS.map((method) => (
          <RowsCheck
            key={method}
            name="methods"
            value={method}
            checked={value.includes(method)}
            disabled={save.busy}
            onChange={() => onChange(toggledMethod(value, method))}
          >
            {method}
          </RowsCheck>
        ))}
      </div>
      <FieldError save={save} field="methods" />
    </div>
  );
}

// one line per team project, a box each, edge to edge in a list card
export function ProjectLines({
  teams,
  value,
  save,
  onChange,
}: {
  teams: { id: string; name: string }[];
  value: string[];
  save: Save;
  onChange: (projectIds: string[]) => void;
}) {
  return (
    <>
      {teams.map((p) => (
        <RowsLine key={p.id} as="label" flush>
          <RowsCheck
            name="projectIds"
            value={p.id}
            checked={value.includes(p.id)}
            disabled={save.busy}
            onChange={() => onChange(toggledId(value, p.id))}
          />
          <RowsTitle name={p.name} mono />
        </RowsLine>
      ))}
    </>
  );
}
