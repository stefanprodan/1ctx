// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Settings tab, laid out as the profile: its description and
// its labels, then its repositories and its MCP servers. Every user who
// sees the project writes its description and labels. A personal
// project's owner writes its repositories, an admin a team project's,
// through the admin page's routes and entities, and a member reads them.
// An admin adds and removes a team project's listed MCP servers. The
// name of a team project is changed on the admin page.

import { useSignal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import type { Params } from "../../app/params.ts";
import { me } from "../../data/me.ts";
import { projects, saveAbout } from "../../data/projects.ts";
import { at, useSave } from "../../lib/save.ts";
import { Bone } from "../../ui/Bones.tsx";
import { Foot } from "../../ui/Foot.tsx";
import { RowsList, RowsWaiting } from "../../ui/Rows.tsx";
import { Section, SectionForm, SectionsWaiting } from "../../ui/Section.tsx";
import {
  descriptionProblem,
  projectFieldOf,
} from "../admin/AdminProjects.model.ts";
import { useLatest } from "../admin/drafts.ts";
import { Frame } from "./Frame.tsx";
import { LABELS_TEXT } from "./Labels.model.ts";
import { Labels } from "./Labels.tsx";
import { mcpText } from "./McpServers.model.ts";
import { McpServers } from "./McpServers.tsx";
import { DescriptionField } from "./ProjectFields.tsx";
import { reposHint } from "./Repos.model.ts";
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

// a list section's head buttons over one row, as each list waits for
// its own answer once the tab is drawn
function ListBones({
  at,
  head,
  buttons = 1,
}: {
  at: number;
  // the head's class, or null for a list that lands with no buttons
  head: string | null;
  buttons?: number;
}) {
  return (
    <div class="field">
      {head !== null && (
        <div class={head}>
          <div class="repos-actions">
            {Array.from({ length: buttons }, (_, i) => (
              <Bone
                key={i}
                kind="button"
                at={at + i}
                class="bones-bone-small"
              />
            ))}
          </div>
        </div>
      )}
      <RowsList>
        <RowsWaiting count={1} shape="plain" label="Loading the list" />
      </RowsList>
    </div>
  );
}

// the tab's sections while the project loads: who may change what is
// known from the rail's list and the user, so the heads' buttons wait
// where they land
function SettingsWaiting({
  personal,
  admin,
}: {
  personal: boolean;
  admin: boolean;
}) {
  return (
    <SectionsWaiting
      label="Loading the settings"
      class="projects-settings"
      sections={[
        {
          title: "About this project",
          text: ABOUT_TEXT,
          body: (
            <div class="field">
              <span class="label bones-lines-line">
                <Bone kind="line" at={0} width={18} />
              </span>
              <Bone kind="rows" at={1} rows={3} />
            </div>
          ),
          foot: true,
        },
        {
          title: "Labels",
          text: LABELS_TEXT,
          body: <ListBones at={4} head="labels-head" />,
        },
        {
          title: "Repositories",
          text: reposHint(personal),
          body: (
            <ListBones
              at={8}
              head={personal || admin ? "repos-head" : null}
              buttons={2}
            />
          ),
        },
        {
          title: "MCP Servers",
          text: mcpText(personal),
          // its Add lands only with servers left to add
          body: <ListBones at={12} head={null} />,
        },
      ]}
    />
  );
}

export function Settings({ params }: { params: Params }) {
  const admin = me.value?.role === "admin";
  const id = params.id ?? "";
  const listed = projects.value?.find((p) => p.id === id);
  return (
    <Frame
      id={id}
      tab="settings"
      waiting={
        <SettingsWaiting personal={listed?.kind === "personal"} admin={admin} />
      }
    >
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
            <McpServers
              key={`mcp-${shown.id}`}
              projectId={shown.id}
              projectName={shown.name}
              personal={personal}
              section
              admin={admin}
            />
          </div>
        );
      }}
    </Frame>
  );
}
