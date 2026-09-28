// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { ProjectDetail } from "../../../shared/contracts/project.ts";
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
import { nameProblem } from "../../lib/names.ts";
import { at, useSave } from "../../lib/save.ts";
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
  nameTaken,
  projectFieldOf,
} from "./AdminProjects.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { holding, useLatest } from "./drafts.ts";

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
        // a card's save in flight could put the project back
        off={saving.value}
        // and a save during the delete would 404
        onDelete={async () => {
          await holding(saving, () => deleteProject(project.id));
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
  const latest = useLatest(project);
  // only the fields edited, so a save elsewhere shows through
  const drafted = useSignal<Partial<About> | null>(null);
  const merged = (row: ProjectDetail): About => ({
    name: row.name,
    description: row.description,
    ...drafted.value,
  });
  const save = useSave(async () => {
    const row = latest.current;
    const body = aboutBody(row, merged(row));
    if (body !== null) await holding(saving, () => updateProject(row.id, body));
    drafted.value = null;
  }, projectFieldOf);
  const d = merged(project);
  const name = d.name.trim();
  const taken =
    name !== project.name &&
    nameTaken(adminProjects.value ?? [], name, project.id);
  const set = (patch: Partial<About>) => {
    drafted.value = { ...drafted.value, ...patch };
    save.touch();
  };
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
        foot={
          <DraftFoot
            save={save}
            dirty={aboutBody(project, d) !== null}
            blocked={taken}
            locked={saving.value && !save.busy}
            hint={
              taken ? <span class="error">{name} is taken.</span> : undefined
            }
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
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
  const latest = useLatest(project);
  const drafted = useSignal<string[] | null>(null);
  const saved = project.members.map((m) => m.id);
  const ids = drafted.value ?? saved;
  const people = users.value;
  const save = useSave(async () => {
    const next = drafted.value;
    if (next !== null) {
      await holding(saving, () => setProjectMembers(latest.current, next));
    }
    drafted.value = null;
  });
  const set = (next: string[]) => {
    drafted.value = next;
    save.touch();
  };
  const off = save.busy || saving.value;
  // a member the users list does not hold yet still shows, from the detail
  const shown = ids.flatMap((id) => {
    const u =
      people?.find((p) => p.id === id) ??
      project.members.find((m) => m.id === id);
    return u === undefined ? [] : [u];
  });
  return (
    <SettingForm save={save}>
      <Setting
        title="Members"
        count={countOf(ids.length, ids.length)}
        list
        action={
          people !== null && (
            <Finder
              label="Users"
              add="Add member"
              disabled={off}
              options={memberOptions(people, ids)}
              placeholder="Find a user"
              none="No user matches"
              empty="Every user is a member"
              onPick={(id) => set(toggledId(ids, id))}
            />
          )
        }
        foot={
          <DraftFoot
            save={save}
            dirty={!sameIds(ids, saved)}
            locked={saving.value && !save.busy}
            hint={
              people === null && usersError.value !== null ? (
                <span class="error">{usersError.value.words}</span>
              ) : undefined
            }
            onDiscard={() => {
              drafted.value = null;
            }}
          />
        }
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
