// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A credential's fields, drawn alike by New credential and by the cards
// of its page: a text field with its hint or its refusal, the key file,
// the methods in one line, and the projects it is bound to with the
// picker that adds one.

import {
  HTTP_METHODS,
  type HttpMethod,
} from "../../../shared/contracts/credential.ts";
import { credentialKeys } from "../../data/credentials.ts";
import { Icon } from "../../lib/icons.tsx";
import { toggledId } from "../../lib/ids.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Finder } from "../../ui/Finder.tsx";
import { RowsCheck, RowsEnd, RowsLine, RowsTitle } from "../../ui/Rows.tsx";
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

// the projects a credential is bound to, by name, each with a remove
export function ProjectRows({
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
      {teams
        .filter((p) => value.includes(p.id))
        .map((p) => (
          <RowsLine key={p.id} flush>
            <RowsTitle name={p.name} mono />
            <RowsEnd>
              <button
                type="button"
                class="btn-icon credentials-remove"
                aria-label={`Remove ${p.name}`}
                title="Remove"
                disabled={save.busy}
                onClick={() => onChange(toggledId(value, p.id))}
              >
                <Icon name="close" size={14} />
              </button>
            </RowsEnd>
          </RowsLine>
        ))}
    </>
  );
}

// Add project: the team projects not bound yet, by name, with a search
export function AddProject({
  teams,
  value,
  disabled,
  onChange,
}: {
  teams: { id: string; name: string }[];
  value: string[];
  disabled: boolean;
  onChange: (projectIds: string[]) => void;
}) {
  return (
    <Finder
      label="Projects"
      trigger={
        <>
          <Icon name="plus" size={14} />
          Add project
        </>
      }
      disabled={disabled}
      options={teams
        .filter((p) => !value.includes(p.id))
        .map((p) => ({ value: p.id, label: p.name }))}
      mono
      align="right"
      placeholder="Find a project"
      none="No project matches"
      empty="Every team project is added"
      onPick={(id) => onChange(toggledId(value, id))}
    />
  );
}
