// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  HTTP_METHODS,
  type HttpMethod,
} from "../../../shared/contracts/credential.ts";
import { credentialKeys } from "../../data/credentials.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { RowsCheck } from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  type CredentialDraft,
  HEADER_PLACEHOLDER,
  keyOptions,
  TEMPLATE_PLACEHOLDER,
  toggledMethod,
} from "./Credentials.model.ts";
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

export function RequestFields({
  d,
  save,
  set,
}: {
  d: Pick<CredentialDraft, "prefix" | "header" | "template">;
  save: Save;
  set: (patch: Partial<CredentialDraft>) => void;
}) {
  return (
    <>
      <TextField
        label="URL prefix"
        name="prefix"
        value={d.prefix}
        placeholder="https://api.github.com/"
        required
        wide
        save={save}
        onInput={(prefix) => set({ prefix })}
      />
      <TextField
        label="Header"
        name="header"
        value={d.header}
        placeholder={HEADER_PLACEHOLDER}
        required
        save={save}
        onInput={(header) => set({ header })}
      />
      <TextField
        label="Value"
        name="template"
        value={d.template}
        placeholder={TEMPLATE_PLACEHOLDER}
        required
        save={save}
        onInput={(template) => set({ template })}
      />
    </>
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
  hint: string | null;
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
        hint !== null && <span class="hint">{hint}</span>
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
