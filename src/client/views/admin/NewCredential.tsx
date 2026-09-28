// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// New credential, the Credentials tab's `?new`: every field in one card
// with one Create, as New server. Create opens the credential's page.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { shapeName } from "../../../shared/names.ts";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  addCredential,
  credentials,
  credentialsError,
} from "../../data/credentials.ts";
import { projects } from "../../data/projects.ts";
import { CREDENTIALS_HREF, configCredentialHref } from "../../lib/hrefs.ts";
import { useFocusField, useSave } from "../../lib/save.ts";
import { touch } from "../../lib/touch.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsList } from "../../ui/Rows.tsx";
import { Setting, SettingHint } from "../../ui/Setting.tsx";
import {
  AddProject,
  KeyField,
  MethodsField,
  ProjectRows,
  TextField,
} from "./CredentialFields.tsx";
import {
  type CredentialDraft,
  canCreate,
  createBody,
  credentialFieldOf,
  draftOf,
  HEADER_PLACEHOLDER,
  keyHint,
  PREFIX_HINT,
  problemOf,
  TEMPLATE_HINT,
  TEMPLATE_PLACEHOLDER,
  teamsOf,
} from "./Credentials.model.ts";
import "./credentials.css";

const STEPS = [
  zoneStep("Config"),
  { label: "Web access", href: CREDENTIALS_HREF },
];

export function NewCredential() {
  const error = credentialsError.value;
  return (
    <Page
      steps={STEPS}
      title="New credential"
      loading={credentials.value === null && error === null}
      error={error}
    >
      <Form />
    </Page>
  );
}

function Form() {
  const draft = useSignal<CredentialDraft>(draftOf(null));
  const form = useRef<HTMLFormElement>(null);
  // with a mouse the name takes the caret on arrival
  useEffect(() => {
    if (!touch()) {
      form.current?.querySelector<HTMLInputElement>('[name="name"]')?.focus();
    }
  }, []);
  const save = useSave(async () => {
    const from = address();
    const created = await addCredential(createBody(draft.value));
    if (address() === from) navigate(configCredentialHref(created.name));
  }, credentialFieldOf);
  useFocusField(save, form);
  const d = draft.value;
  const set = (patch: Partial<CredentialDraft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const name = d.name.trim();
  const taken = (credentials.value ?? []).some((c) => c.name === name);
  const teams = teamsOf(projects.value ?? [], null);
  return (
    <form
      class="credentials-form"
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(problemOf(d, true));
      }}
    >
      <Setting
        label="New credential"
        foot={
          <Foot
            save={save}
            dirty={canCreate(d) && !taken}
            label="Create credential"
            stack={taken}
            start={
              <SettingHint>
                {taken && <span class="error">{name} is taken.</span>}
              </SettingHint>
            }
            before={
              <a class="btn" href={CREDENTIALS_HREF}>
                Cancel
              </a>
            }
          />
        }
      >
        <div class="pair">
          <TextField
            label="Name"
            name="name"
            value={d.name}
            placeholder="github"
            required
            save={save}
            onInput={(value) => set({ name: shapeName(value) })}
          />
          <KeyField
            value={d.keyName}
            hint={keyHint(d.keyName, null)}
            save={save}
            onChange={(keyName) => set({ keyName })}
          />
          <TextField
            label="URL prefix"
            name="prefix"
            value={d.prefix}
            placeholder="https://api.github.com/"
            hint={PREFIX_HINT}
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
            hint={TEMPLATE_HINT}
            required
            save={save}
            onInput={(template) => set({ template })}
          />
          <MethodsField
            label="Methods"
            value={d.methods}
            save={save}
            onChange={(methods) => set({ methods })}
          />
          <div class="field pair-wide">
            <div class="credentials-projects-head">
              <span class="label">Projects</span>
              {projects.value !== null && (
                <AddProject
                  teams={teams}
                  value={d.projectIds}
                  disabled={save.busy}
                  onChange={(projectIds) => set({ projectIds })}
                />
              )}
            </div>
            {d.projectIds.length === 0 ? (
              <span class="hint">
                None yet. It signs nothing until a project is added.
              </span>
            ) : (
              <RowsList>
                <ProjectRows
                  teams={teams}
                  value={d.projectIds}
                  save={save}
                  onChange={(projectIds) => set({ projectIds })}
                />
              </RowsList>
            )}
            <FieldError save={save} field="projectIds" />
          </div>
        </div>
      </Setting>
    </form>
  );
}
