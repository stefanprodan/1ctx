// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Web tab's Credentials card: a row per HTTP credential, the name
// over its prefix, its projects and its key file at the right, marked
// when the file is missing or cannot be used. New credential opens the
// form at the top; a row opens to the same fields, Save and Delete
// asked once. The projects are the team projects the admin sees.

import { useSignal } from "@preact/signals";
import { useRef } from "preact/hooks";
import {
  type CredentialSummary,
  HTTP_METHODS,
} from "../../../shared/contracts/credential.ts";
import { shapeName } from "../../../shared/words.ts";
import {
  addCredential,
  credentialKeys,
  credentials,
  deleteCredential,
  patchCredential,
} from "../../data/credentials.ts";
import { projects } from "../../data/projects.ts";
import { toggledId } from "../../lib/ids.ts";
import { type Save, useFocusField, useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsAdd,
  RowsCard,
  RowsCheck,
  RowsLine,
  RowsList,
  RowsListHead,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import {
  CARD_NOTE,
  type CredentialDraft,
  createBody,
  credentialFieldOf,
  dirtyOf,
  draftOf,
  HEADER_PLACEHOLDER,
  keyLine,
  keyOptions,
  PREFIX_HINT,
  patchBody,
  problemOf,
  projectsLine,
  TEMPLATE_HINT,
  TEMPLATE_PLACEHOLDER,
  toggledMethod,
  totalLine,
} from "./CredentialsCard.model.ts";
import "./credentials.css";

// a text field with its hint, or the refusal in the hint's place
function TextField({
  label,
  name,
  value,
  placeholder,
  hint,
  required,
  save,
  disabled,
  onInput,
}: {
  label: string;
  name: string;
  value: string;
  placeholder: string;
  hint?: string;
  required?: boolean;
  save: Save;
  disabled: boolean;
  onInput: (value: string) => void;
}) {
  const invalid = save.fieldError(name) !== null;
  return (
    <label class="field">
      <span class={`label${required ? " label-required" : ""}`}>{label}</span>
      <input
        name={name}
        class="credentials-mono"
        aria-required={required ? "true" : undefined}
        autocomplete="off"
        spellcheck={false}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        disabled={disabled}
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

function CredentialForm({
  credential,
  onDone,
}: {
  // null for a new one
  credential: CredentialSummary | null;
  onDone: () => void;
}) {
  const draft = useSignal<CredentialDraft>(draftOf(credential));
  const asking = useSignal(false);
  const form = useRef<HTMLFormElement>(null);
  const save = useSave(async () => {
    if (credential === null) {
      await addCredential(createBody(draft.value));
      onDone();
    } else {
      await patchCredential(credential.id, patchBody(draft.value, credential));
    }
  }, credentialFieldOf);
  useFocusField(save, form);
  const d = draft.value;
  const set = (patch: Partial<CredentialDraft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const busy = save.busy;
  const invalid = (field: string) => save.fieldError(field) !== null;
  // every team project the admin sees, and any the row names besides
  const teams = [
    ...(projects.value ?? []).filter((p) => p.kind === "team"),
    ...(credential?.projects ?? []).filter(
      (p) => !(projects.value ?? []).some((q) => q.id === p.id),
    ),
  ];
  const keyHint =
    credential === null || credential.keyName !== d.keyName
      ? "An http- file in the secrets directory"
      : credential.key === "ok"
        ? `${credential.keyName}.key is present`
        : `${credential.keyName}.key is ${credential.key}`;
  const remove = async () => {
    if (credential === null) return;
    await save.act("delete", () => deleteCredential(credential.id));
  };
  return (
    <form
      class="credentials-form"
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        void save.run(problemOf(d, credential === null));
      }}
    >
      <div class="pair">
        {credential === null && (
          <TextField
            label="Name"
            name="name"
            value={d.name}
            placeholder="finnhub"
            required
            save={save}
            disabled={busy}
            onInput={(value) => set({ name: shapeName(value) })}
          />
        )}
        <div class="field">
          <span class="label label-required">Key</span>
          <Select
            label="Key"
            name="keyName"
            mono
            value={d.keyName}
            placeholder="Pick a key"
            options={keyOptions(credentialKeys.value, d.keyName)}
            disabled={busy}
            invalid={invalid("keyName")}
            onChange={(keyName) => set({ keyName })}
          />
          {invalid("keyName") ? (
            <FieldError save={save} field="keyName" />
          ) : (
            <span class="hint">{keyHint}</span>
          )}
        </div>
        <div class="pair-wide">
          <TextField
            label="URL prefix"
            name="prefix"
            value={d.prefix}
            placeholder="https://api.example.com/v1/"
            hint={PREFIX_HINT}
            required
            save={save}
            disabled={busy}
            onInput={(prefix) => set({ prefix })}
          />
        </div>
        <TextField
          label="Header"
          name="header"
          value={d.header}
          placeholder={HEADER_PLACEHOLDER}
          required
          save={save}
          disabled={busy}
          onInput={(header) => set({ header })}
        />
        <TextField
          label="Value"
          name="template"
          value={d.template}
          placeholder={TEMPLATE_PLACEHOLDER}
          hint={TEMPLATE_HINT}
          required
          save={save}
          disabled={busy}
          onInput={(template) => set({ template })}
        />
        <div class="field pair-wide">
          <span class="label">Methods</span>
          <div class="credentials-methods">
            {HTTP_METHODS.map((method) => (
              <RowsCheck
                key={method}
                name="methods"
                value={method}
                checked={d.methods.includes(method)}
                disabled={busy}
                onChange={() =>
                  set({ methods: toggledMethod(d.methods, method) })
                }
              >
                {method}
              </RowsCheck>
            ))}
          </div>
          <FieldError save={save} field="methods" />
        </div>
        <div class="field pair-wide">
          <RowsListHead
            label="Projects"
            hint={
              teams.length > 0
                ? `${d.projectIds.length} of ${teams.length}`
                : undefined
            }
          />
          {teams.length === 0 ? (
            <span class="hint">No team projects yet</span>
          ) : (
            <RowsList>
              {teams.map((p) => (
                <RowsLine key={p.id} as="label" flush>
                  <RowsCheck
                    name="projectIds"
                    value={p.id}
                    checked={d.projectIds.includes(p.id)}
                    disabled={busy}
                    onChange={() =>
                      set({ projectIds: toggledId(d.projectIds, p.id) })
                    }
                  />
                  <RowsTitle name={p.name} mono />
                </RowsLine>
              ))}
            </RowsList>
          )}
          <FieldError save={save} field="projectIds" />
        </div>
      </div>
      {credential === null ? (
        <Foot
          save={save}
          dirty
          label="Add credential"
          start={<span />}
          before={
            <button type="button" class="btn" disabled={busy} onClick={onDone}>
              Cancel
            </button>
          }
        />
      ) : (
        <Foot
          save={save}
          dirty={dirtyOf(d, credential)}
          label="Save"
          start={
            <AskDelete
              save={save}
              asking={asking}
              busy={busy}
              words={`Delete ${credential.name}?`}
              wordsClass="credentials-ask"
              onDelete={() => void remove()}
            />
          }
        />
      )}
    </form>
  );
}

export function CredentialsCard() {
  const list = credentials.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  if (list === null) return null;
  return (
    <RowsCard
      label="Credentials"
      hint={totalLine(list.length)}
      action={
        <RowsAdd
          label="New credential"
          disabled={adding.value}
          onClick={() => {
            adding.value = true;
            open.value = null;
          }}
        />
      }
    >
      <RowsNote>{CARD_NOTE}</RowsNote>
      {adding.value && (
        <RowsNew>
          <CredentialForm
            credential={null}
            onDone={() => {
              adding.value = false;
            }}
          />
        </RowsNew>
      )}
      {list.map((credential) => {
        const key = keyLine(credential.keyName, credential.key);
        return (
          <RowsOpen
            key={credential.id}
            open={open.value === credential.id}
            onToggle={() => {
              open.value = open.value === credential.id ? null : credential.id;
              adding.value = false;
            }}
            indent="chevron"
            head={
              <>
                <RowsTitle
                  name={credential.name}
                  sub={`${credential.prefix} · ${projectsLine(credential)}`}
                  mono
                />
                <RowsMeta bad={key.bad}>{key.text}</RowsMeta>
              </>
            }
          >
            <CredentialForm
              credential={credential}
              onDone={() => {
                open.value = null;
              }}
            />
          </RowsOpen>
        );
      })}
    </RowsCard>
  );
}
