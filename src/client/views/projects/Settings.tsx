// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Settings tab, laid out as the profile: its description and
// its labels, then its repositories. Every user who sees the project
// writes its description and labels. A personal project's owner writes
// its repositories, an admin a team project's, through the admin page's
// routes and entities, and a member reads them. The name of a team
// project is changed on the admin page.

import { useSignal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import type { Params } from "../../app/params.ts";
import { me } from "../../data/me.ts";
import { saveAbout } from "../../data/projects.ts";
import { at, useSave } from "../../lib/save.ts";
import { Foot } from "../../ui/Foot.tsx";
import { Section, SectionForm } from "../../ui/Section.tsx";
import {
  descriptionProblem,
  projectFieldOf,
} from "../admin/AdminProjects.model.ts";
import { useLatest } from "../admin/drafts.ts";
import { Frame } from "./Frame.tsx";
import { Labels } from "./Labels.tsx";
import { DescriptionField } from "./ProjectFields.tsx";
import { Repos } from "./Repos.tsx";

const ABOUT_TEXT = "What agents should know about it.";

function SettingsForm({ project }: { project: ProjectDetail }) {
  const team = project.kind === "team";
  // null until edited: an untouched field follows the project, so a
  // newer description from another save is never sent back as stale
  const drafted = useSignal<string | null>(null);
  const saved = useLatest(project.description);
  const current = () => drafted.value ?? saved.current;
  const description = current();
  const save = useSave(async () => {
    await saveAbout(project.id, { description: current().trim() });
    drafted.value = null;
  }, projectFieldOf);
  const submit = (event: Event) => {
    event.preventDefault();
    // a team project's description is required, a personal one's not
    void save.run(
      team ? at("description", descriptionProblem(current())) : null,
    );
  };
  const busy = save.busy;
  return (
    <SectionForm onSubmit={submit}>
      <DescriptionField
        required={team}
        disabled={busy}
        error={save.fieldError("description")}
        value={description}
        onInput={(value) => {
          drafted.value = value;
          save.touch();
        }}
      />
      <Foot
        save={save}
        dirty={description.trim() !== project.description}
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
        return (
          <div class="projects-settings">
            <Section title="About this project" text={ABOUT_TEXT}>
              <SettingsForm key={shown.id} project={shown} />
            </Section>
            <Labels key={`labels-${shown.id}`} project={shown} />
            <Repos
              key={shown.id}
              projectId={shown.id}
              personal={personal}
              section
              edit={personal || admin}
            />
          </div>
        );
      }}
    </Frame>
  );
}
