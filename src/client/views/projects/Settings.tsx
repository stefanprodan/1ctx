// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A personal project's Settings tab, laid out as the profile: its owner
// describes it, and its name is always personal. A team project is an
// admin's to change, on the admin page.

import { useSignal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import type { Params } from "../../app/params.ts";
import { savePersonalProject } from "../../data/projects.ts";
import { useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Section, SectionForm } from "../../ui/Section.tsx";
import { Frame } from "./Frame.tsx";
import { DescriptionField } from "./ProjectFields.tsx";

function SettingsForm({ project }: { project: ProjectDetail }) {
  const description = useSignal(project.description);
  const save = useSave(() =>
    savePersonalProject({ description: description.value.trim() }),
  );
  const submit = (event: Event) => {
    event.preventDefault();
    void save.run(null);
  };
  const busy = save.status.value === "busy";
  return (
    <SectionForm onSubmit={submit}>
      <DescriptionField
        hint={false}
        disabled={busy}
        value={description.value}
        onInput={(value) => {
          description.value = value;
          save.touch();
        }}
      />
      <Foot
        status={save.status.value}
        dirty={description.value.trim() !== project.description}
        label="Save"
      />
    </SectionForm>
  );
}

export function Settings({ params }: { params: Params }) {
  return (
    <Frame id={params.id ?? ""} tab="settings">
      {(shown) => (
        <div class="projects-settings">
          <Section
            title="About this project"
            text={
              shown.kind === "personal"
                ? "What agents should know about it."
                : "An admin manages a team project."
            }
          >
            {shown.kind === "personal" && (
              <SettingsForm key={shown.id} project={shown} />
            )}
          </Section>
        </div>
      )}
    </Frame>
  );
}
