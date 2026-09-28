// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
import { RESERVED_PROJECT_NAMES } from "../../../shared/words.ts";
import type { Params } from "../../app/params.ts";
import { zoneStep } from "../../app/zones.ts";
import {
  adminProject,
  adminProjectError,
  adminProjects,
  adminProjectsError,
  deleteProject,
  projectUsage,
  setProjectMembers,
  updateProject,
} from "../../data/admin-projects.ts";
import { users, usersError } from "../../data/users.ts";
import { count, dayMonthYear, initials, plural } from "../../lib/format.ts";
import { adminProjectHref, PROJECTS_HREF } from "../../lib/hrefs.ts";
import { sameIds, toggledId } from "../../lib/ids.ts";
import { nameProblem, nameTaken } from "../../lib/names.ts";
import { at } from "../../lib/save.ts";
import { countOf } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { Page, PageSwitcher } from "../../ui/Page.tsx";
import {
  RowsAvatar,
  RowsEnd,
  RowsLine,
  RowsNote,
  RowsRemove,
  RowsTitle,
} from "../../ui/Rows.tsx";
import {
  Setting,
  SettingDelete,
  SettingForm,
  SettingStack,
} from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { DescriptionField, NameField } from "../projects/ProjectFields.tsx";
import { SpendLines, UsageSection } from "./AdminAside.tsx";
import {
  DESCRIPTION_PLACEHOLDER,
  deleteLine,
  descriptionProblem,
  memberOptions,
  projectFieldOf,
} from "./AdminProjects.model.ts";
import { useDraftCard } from "./DraftCard.tsx";

const STEPS = [zoneStep("Access"), { label: "Projects", href: PROJECTS_HREF }];

export function ProjectPage({ params }: { params: Params }) {
  // by id, so a rename keeps the address
  const id = params.id ?? "";
  const list = adminProjects.value;
  // the delete drops the row and leaves in one run of microtasks, so no
  // frame without it is painted
  const listed = list?.find((p) => p.id === id) ?? null;
  const detail = adminProject.value?.id === id ? adminProject.value : null;
  const listError = adminProjectsError.value;
  const detailError = adminProjectError.value;
  const missing = list !== null && listed === null;
  return (
    <Page
      steps={STEPS}
      title={listed?.name ?? detail?.name ?? "Project"}
      titleMono
      menu={
        listed !== null ? (
          <PageSwitcher
            label="Projects"
            current={listed.id}
            name={listed.name}
            items={(list ?? []).map((p) => ({
              id: p.id,
              label: p.name,
              href: adminProjectHref(p.id),
            }))}
            placeholder="Find a project"
            none="No project matches"
          />
        ) : undefined
      }
      split
      loading={
        !missing &&
        (list === null ? listError === null : detail === null) &&
        detailError === null
      }
      empty={missing ? "No team project by that id." : undefined}
      // a failed read after a save keeps the page: the card that saved
      // says what went wrong
      error={
        missing
          ? null
          : list === null
            ? (listError ?? detailError)
            : detail === null
              ? detailError
              : null
      }
    >
      {!missing && detail !== null && (
        <Split aside={<Aside project={detail} />}>
          <Body key={detail.id} project={detail} />
        </Split>
      )}
    </Page>
  );
}

type CardProps = { project: ProjectDetail; saving: Signal<boolean> };

function Body({ project }: { project: ProjectDetail }) {
  // one card saves at a time, so a slower answer never puts back what a
  // later save changed
  const saving = useSignal(false);
  return (
    <SettingStack>
      <AboutCard project={project} saving={saving} />
      <MembersCard project={project} saving={saving} />
      <SettingDelete
        title={`Delete ${project.name}`}
        line={deleteLine(project)}
        ask={`Delete ${project.name}?`}
        // a save in flight could put the project back, one during it would 404
        lock={saving}
        onDelete={async () => {
          await deleteProject(project.id);
        }}
        leaveTo={PROJECTS_HREF}
      />
    </SettingStack>
  );
}

type About = { name: string; description: string };

function aboutBody(row: ProjectDetail, d: About): Partial<About> | null {
  const body: Partial<About> = {};
  if (d.name.trim() !== row.name) body.name = d.name.trim();
  if (d.description.trim() !== row.description) {
    body.description = d.description.trim();
  }
  return Object.keys(body).length === 0 ? null : body;
}

function AboutCard({ project, saving }: CardProps) {
  const card = useDraftCard({
    row: project,
    saving,
    of: (row): About => ({ name: row.name, description: row.description }),
    dirty: (d, row) => aboutBody(row, d) !== null,
    send: async (d, row) => {
      const body = aboutBody(row, d);
      if (body !== null) await updateProject(row.id, body);
    },
    fieldOf: projectFieldOf,
  });
  const { d, save, set } = card;
  const name = d.name.trim();
  const taken =
    name !== project.name &&
    nameTaken(adminProjects.value, name, project.id, RESERVED_PROJECT_NAMES);
  return (
    <SettingForm
      save={save}
      check={() =>
        at("name", nameProblem(d.name)) ??
        at("description", descriptionProblem(d.description))
      }
    >
      <Setting
        label="About"
        foot={card.foot({
          blocked: taken,
          hint: taken ? <span class="error">{name} is taken.</span> : undefined,
        })}
      >
        <div class="pair">
          <NameField
            disabled={save.busy}
            error={save.fieldError("name")}
            value={d.name}
            onInput={(value) => set({ name: value })}
          />
          <DescriptionField
            class="pair-wide"
            required
            placeholder={DESCRIPTION_PLACEHOLDER}
            disabled={save.busy}
            error={save.fieldError("description")}
            value={d.description}
            onInput={(value) => set({ description: value })}
          />
        </div>
      </Setting>
    </SettingForm>
  );
}

function MembersCard({ project, saving }: CardProps) {
  const card = useDraftCard({
    row: project,
    saving,
    of: (row) => ({ ids: row.members.map((m) => m.id) }),
    dirty: (d, row) =>
      !sameIds(
        d.ids,
        row.members.map((m) => m.id),
      ),
    send: (d, row) => setProjectMembers(row, d.ids),
  });
  const { ids } = card.d;
  const set = (next: string[]) => card.set({ ids: next });
  const everyone = users.value;
  const off = card.save.busy || saving.value;
  // a member the users list does not hold yet still shows, from the detail
  const shown = ids.flatMap((id) => {
    const u =
      everyone?.find((p) => p.id === id) ??
      project.members.find((m) => m.id === id);
    return u === undefined ? [] : [u];
  });
  return (
    <SettingForm save={card.save}>
      <Setting
        title="Members"
        count={countOf(ids.length, ids.length)}
        list
        action={
          everyone !== null && (
            <Finder
              label="Users"
              add="Add member"
              disabled={off}
              options={memberOptions(everyone, ids)}
              placeholder="Find a user"
              none="No user matches"
              empty="Every user is a member"
              onPick={(id) => set(toggledId(ids, id))}
            />
          )
        }
        foot={card.foot({
          hint:
            everyone === null && usersError.value !== null ? (
              <span class="error">{usersError.value.words}</span>
            ) : undefined,
        })}
      >
        {shown.length === 0 ? (
          <RowsNote>No members yet.</RowsNote>
        ) : (
          shown.map((u) => (
            <RowsLine key={u.id} flush>
              <RowsAvatar>{initials(u.fullName)}</RowsAvatar>
              <RowsTitle name={u.fullName} sub={`@${u.username}`} />
              <RowsEnd>
                <RowsRemove
                  name={`@${u.username}`}
                  disabled={off}
                  onRemove={() => set(toggledId(ids, u.id))}
                />
              </RowsEnd>
            </RowsLine>
          ))
        )}
      </Setting>
    </SettingForm>
  );
}

function Aside({ project }: { project: ProjectDetail }) {
  return (
    <>
      <UsageSection value={projectUsage.valueFor(project.id)}>
        {(usage) => (
          <SpendLines
            label="Turns"
            count={usage.sends}
            tokens={usage.tokens}
            cost={usage.cost}
          />
        )}
      </UsageSection>
      <AsideSection label="Project">
        <AsideLine label="Members">{count(project.members.length)}</AsideLine>
        <AsideLine label="Chats">{count(project.chats)}</AsideLine>
        <AsideLine label="Knowledge" quiet={project.knowledge.files === 0}>
          {plural(project.knowledge.files, "file")}
        </AsideLine>
        <AsideLine label="Created">{dayMonthYear(project.createdAt)}</AsideLine>
      </AsideSection>
    </>
  );
}
