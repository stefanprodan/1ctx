// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
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
import { useSave } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Page } from "../../ui/Page.tsx";
import { RowsList } from "../../ui/Rows.tsx";
import {
  KeyField,
  MethodsField,
  RequestFields,
  TextField,
} from "./CredentialFields.tsx";
import {
  type CredentialDraft,
  createBody,
  credentialFieldOf,
  draftOf,
  keyHint,
  problemOf,
  teamsOf,
} from "./Credentials.model.ts";
import { NewCard } from "./NewCard.tsx";
import { AddProject, ProjectRows } from "./ProjectPicks.tsx";
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
  const save = useSave(async () => {
    const from = address();
    const created = await addCredential(createBody(draft.value));
    if (address() === from) navigate(configCredentialHref(created.name));
  }, credentialFieldOf);
  const d = draft.value;
  const set = (patch: Partial<CredentialDraft>) => {
    draft.value = { ...draft.value, ...patch };
    save.touch();
  };
  const name = d.name.trim();
  const taken = (credentials.value ?? []).some((c) => c.name === name);
  const teams = teamsOf(projects.value ?? [], null);
  return (
    <NewCard
      label="New credential"
      create="Create credential"
      cancel={CREDENTIALS_HREF}
      save={save}
      ready={name !== ""}
      taken={taken ? name : null}
      first="name"
      onSubmit={() => void save.run(problemOf(d, true))}
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
        <RequestFields d={d} save={save} set={set} />
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
            <span class="hint">No projects yet.</span>
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
    </NewCard>
  );
}
