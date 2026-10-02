// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Settings tab, laid out as the profile: its description,
// then its repositories. An owner writes their personal project's, which
// is always named personal. An admin writes a team project's here as on
// the admin page, through the same routes and entities, and a member
// reads them. The name of a team project is changed on the admin page.

import { useSignal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import type { Params } from "../../app/params.ts";
import { updateProject } from "../../data/admin-projects.ts";
import { me } from "../../data/me.ts";
import { savePersonalProject } from "../../data/projects.ts";
import { at, useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Section, SectionForm } from "../../ui/Section.tsx";
import {
  descriptionProblem,
  projectFieldOf,
} from "../admin/AdminProjects.model.ts";
import { Frame } from "./Frame.tsx";
import { DescriptionField } from "./ProjectFields.tsx";
import { Repos } from "./Repos.tsx";

const ABOUT_TEXT = "What agents should know about it.";

function SettingsForm({ project }: { project: ProjectDetail }) {
  const team = project.kind === "team";
  const description = useSignal(project.description);
  const save = useSave(
    () =>
      team
        ? updateProject(project.id, {
            description: description.value.trim(),
          }).then(() => {})
        : savePersonalProject({ description: description.value.trim() }),
    projectFieldOf,
  );
  const submit = (event: Event) => {
    event.preventDefault();
    // a team project's description is required, a personal one's not
    void save.run(
      team ? at("description", descriptionProblem(description.value)) : null,
    );
  };
  const busy = save.busy;
  return (
    <SectionForm onSubmit={submit}>
      <DescriptionField
        required={team}
        disabled={busy}
        error={save.fieldError("description")}
        value={description.value}
        onInput={(value) => {
          description.value = value;
          save.touch();
        }}
      />
      <Foot
        save={save}
        dirty={description.value.trim() !== project.description}
        label="Save"
      />
    </SectionForm>
  );
}

export function Settings({ params }: { params: Params }) {
  const admin = me.value?.role === "admin";
  return (
    <Frame id={params.id ?? ""} tab="settings">
      {(shown) => {
        const personal = shown.kind === "personal";
        const edit = personal || admin;
        return (
          <div class="projects-settings">
            <Section title="About this project" text={ABOUT_TEXT}>
              {edit ? (
                <SettingsForm key={shown.id} project={shown} />
              ) : (
                <p
                  class={`projects-about${
                    shown.description === "" ? " projects-about-none" : ""
                  }`}
                >
                  {shown.description === ""
                    ? "No description yet."
                    : shown.description}
                </p>
              )}
            </Section>
            <Repos
              key={shown.id}
              projectId={shown.id}
              personal={personal}
              section
              edit={edit}
            />
          </div>
        );
      }}
    </Frame>
  );
}
