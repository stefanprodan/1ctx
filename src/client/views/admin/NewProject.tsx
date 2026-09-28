// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { address, navigate } from "../../app/router.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  adminProjects,
  adminProjectsError,
  createProject,
} from "../../data/admin-projects.ts";
import { adminProjectHref, PROJECTS_HREF } from "../../lib/hrefs.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
import { Page } from "../../ui/Page.tsx";
import { DescriptionField, NameField } from "../projects/ProjectFields.tsx";
import {
  DESCRIPTION_PLACEHOLDER,
  descriptionProblem,
  nameTaken,
  projectFieldOf,
} from "./AdminProjects.model.ts";
import { NewCard } from "./NewCard.tsx";

const STEPS = [zoneStep("Access"), { label: "Projects", href: PROJECTS_HREF }];

export function NewProject() {
  const error = adminProjectsError.value;
  return (
    <Page
      steps={STEPS}
      title="New project"
      loading={adminProjects.value === null && error === null}
      error={error}
    >
      <Form />
    </Page>
  );
}

function Form() {
  const name = useSignal("");
  const description = useSignal("");
  const save = useSave(async () => {
    const from = address();
    const created = await createProject({
      name: name.value.trim(),
      description: description.value.trim(),
    });
    if (address() === from) navigate(adminProjectHref(created.id));
  }, projectFieldOf);
  const trimmed = name.value.trim();
  const taken = nameTaken(adminProjects.value ?? [], trimmed);
  return (
    <NewCard
      label="New project"
      create="Create project"
      cancel={PROJECTS_HREF}
      save={save}
      ready={trimmed !== ""}
      taken={taken ? trimmed : null}
      first="name"
      onSubmit={() =>
        void save.run(
          at("name", nameProblem(name.value)) ??
            at("description", descriptionProblem(description.value)),
        )
      }
    >
      <div class="pair">
        <NameField
          disabled={save.busy}
          error={save.fieldError("name")}
          value={name.value}
          onInput={(value) => {
            name.value = value;
            save.touch();
          }}
        />
        <DescriptionField
          class="pair-wide"
          required
          placeholder={DESCRIPTION_PLACEHOLDER}
          disabled={save.busy}
          error={save.fieldError("description")}
          value={description.value}
          onInput={(value) => {
            description.value = value;
            save.touch();
          }}
        />
      </div>
    </NewCard>
  );
}
