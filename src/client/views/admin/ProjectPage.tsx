// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A team project's admin page under Access, by id so a rename keeps the
// address: the crumb is the head, its own step the switcher to the other
// team projects; then a card per setting, each drafting and saving
// apart, nothing before Save: the name and the description, the
// members, and Delete last. The aside has the project's last 30 days
// and what it holds.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../shared/contracts/project.ts";
import type { Params } from "../../app/params.ts";
import { address, navigate } from "../../app/router.ts";
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
import { Icon } from "../../lib/icons.tsx";
import { toggledId } from "../../lib/ids.ts";
import { nameProblem } from "../../lib/names.ts";
import { at, useFocusField, useSave } from "../../lib/save.ts";
import { Finder } from "../../ui/Finder.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  RowsAvatar,
  RowsEnd,
  RowsLine,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { AsideLine, AsideSection, Split } from "../../ui/Split.tsx";
import { DescriptionField, NameField } from "../projects/ProjectFields.tsx";
import {
  DESCRIPTION_PLACEHOLDER,
  deleteLine,
  descriptionProblem,
  memberOptions,
  nameTaken,
  projectFieldOf,
} from "./AdminProjects.model.ts";
import { DraftFoot } from "./DraftFoot.tsx";
import { money } from "./Overview.model.ts";
import { locked } from "./UserCards.tsx";
import "./admin-projects.css";

const STEPS = [zoneStep("Access"), { label: "Projects", href: PROJECTS_HREF }];

export function ProjectPage({ params }: { params: Params }) {
  const id = params.id ?? "";
  const list = adminProjects.value;
  // this page's own delete drops the project before the address leaves
  // it: the project shown last stays until then
  const leaving = useSignal(false);
  const last = useRef<{ listed: ProjectSummary; detail: ProjectDetail }>();
  const held = leaving.value && last.current?.detail.id === id;
  const listed =
    list?.find((p) => p.id === id) ?? (held ? last.current!.listed : null);
  const detail =
    adminProject.value?.id === id
      ? adminProject.value
      : held
        ? last.current!.detail
        : null;
  if (listed !== null && detail !== null) last.current = { listed, detail };
  const listError = adminProjectsError.value;
  const detailError = adminProjectError.value;
  const missing = list !== null && listed === null;
  return (
    <Page
      steps={STEPS}
      title={listed?.name ?? detail?.name ?? "Project"}
      titleMono
      menu={listed !== null ? <Switcher project={listed} /> : undefined}
      split
      loading={
        !missing &&
        (list === null ? listError === null : detail === null) &&
        detailError === null
      }
      empty={missing ? "No team project by that id." : undefined}
      // a failed read after a save keeps the page it had: the card that
      // saved says what went wrong
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
          <Body key={detail.id} project={detail} leaving={leaving} />
        </Split>
      )}
    </Page>
  );
}

// the crumb's own step: the other team projects by name
function Switcher({ project }: { project: ProjectSummary }) {
  const list = adminProjects.value ?? [];
  if (list.length < 2) {
    return <span class="page-crumb-on page-crumb-path">{project.name}</span>;
  }
  return (
    <Finder
      label="Projects"
      triggerClass="page-pill"
      title={project.name}
      trigger={
        <>
          <span class="cut">{project.name}</span>
          <Icon name="chevron" size={14} class="page-pill-chevron" />
        </>
      }
      options={list.map((p) => ({
        value: p.id,
        label: p.name,
        href: adminProjectHref(p.id),
      }))}
      value={project.id}
      mono
      wide
      placeholder="Find a project"
      none="No project matches"
    />
  );
}

type CardProps = { project: ProjectDetail; saving: Signal<boolean> };

function Body({
  project,
  leaving,
}: {
  project: ProjectDetail;
  leaving: Signal<boolean>;
}) {
  // one card saves at a time, so a slower answer never puts back what
  // a later save changed
  const saving = useSignal(false);
  return (
    <div class="admin-projects-page">
      <AboutCard project={project} saving={saving} />
      <MembersCard project={project} saving={saving} />
      <DeleteCard project={project} saving={saving} leaving={leaving} />
    </div>
  );
}

// the row as a save reads it, so a save of another card in between is
// not undone
function useLatest(project: ProjectDetail) {
  const latest = useRef(project);
  latest.current = project;
  return latest;
}

type About = { name: string; description: string };

// what the draft changed of the saved row, trimmed; null for nothing
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
  const form = useRef<HTMLFormElement>(null);
  const merged = (row: ProjectDetail): About => ({
    name: row.name,
    description: row.description,
    ...drafted.value,
  });
  const save = useSave(async () => {
    const row = latest.current;
    const body = aboutBody(row, merged(row));
    if (body !== null) await locked(saving, () => updateProject(row.id, body));
    drafted.value = null;
  }, projectFieldOf);
  useFocusField(save, form);
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
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(
          at("name", nameProblem(d.name)) ??
            at("description", descriptionProblem(d.description)),
        );
      }}
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
    </form>
  );
}

// the users in it, each with a remove, and Add member over the others
function MembersCard({ project, saving }: CardProps) {
  const latest = useLatest(project);
  const drafted = useSignal<string[] | null>(null);
  const saved = project.members.map((m) => m.id);
  const ids = drafted.value ?? saved;
  const people = users.value;
  const save = useSave(async () => {
    if (drafted.value !== null) {
      const ids = drafted.value;
      await locked(saving, () => setProjectMembers(latest.current, ids));
    }
    drafted.value = null;
  });
  const set = (next: string[]) => {
    drafted.value = next;
    save.touch();
  };
  const dirty =
    ids.length !== saved.length || ids.some((id) => !saved.includes(id));
  // a member the users list does not hold yet still shows, from the detail
  const shown = ids.flatMap((id) => {
    const u =
      people?.find((p) => p.id === id) ??
      project.members.find((m) => m.id === id);
    return u === undefined ? [] : [u];
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(null);
      }}
    >
      <Setting
        title="Members"
        count={String(ids.length)}
        list
        action={
          people !== null && (
            <Finder
              label="Users"
              trigger={
                <>
                  <Icon name="plus" size={14} />
                  Add member
                </>
              }
              disabled={save.busy || saving.value}
              options={memberOptions(people, ids)}
              align="right"
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
            dirty={dirty}
            locked={saving.value && !save.busy}
            // Add member needs the users
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
                <button
                  type="button"
                  class="btn-icon admin-projects-remove"
                  aria-label={`Remove @${u.username}`}
                  title="Remove"
                  disabled={save.busy || saving.value}
                  onClick={() => set(toggledId(ids, u.id))}
                >
                  <Icon name="close" size={14} />
                </button>
              </RowsEnd>
            </RowsLine>
          ))
        )}
      </Setting>
    </form>
  );
}

function DeleteCard({
  project,
  saving,
  leaving,
}: CardProps & { leaving: Signal<boolean> }) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
  // Escape takes the ask back
  useEffect(() => {
    if (!asking.value) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") asking.value = false;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking.value]);
  return (
    <Setting
      danger
      title={`Delete ${project.name}`}
      line={deleteLine(project)}
      foot={
        <Foot save={save}>
          <div class="admin-projects-delete">
            <AskDelete
              save={save}
              asking={asking}
              // a card's save in flight could put the project back
              busy={save.busy || saving.value}
              words={`Delete ${project.name}?`}
              wordsClass="admin-projects-ask"
              // the list drops the project as the call ends, which takes
              // this page away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  const from = address();
                  leaving.value = true;
                  try {
                    // the other cards wait, since a save now would 404
                    await locked(saving, () => deleteProject(project.id));
                  } catch (err) {
                    leaving.value = false;
                    throw err;
                  }
                  if (address() === from) navigate(PROJECTS_HREF);
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}

function Aside({ project }: { project: ProjectDetail }) {
  const known = project.id in projectUsage.value;
  const usage = projectUsage.value[project.id] ?? null;
  return (
    <>
      <AsideSection label="Last 30 days">
        {!known ? (
          <p class="split-empty">Loading</p>
        ) : usage === null ? (
          <p class="split-empty">Did not load.</p>
        ) : (
          <>
            <AsideLine label="Turns">{count(usage.sends)}</AsideLine>
            <AsideLine label="Tokens">{count(usage.tokens)}</AsideLine>
            <AsideLine label="Cost">
              {usage.cost === null ? "not priced" : money(usage.cost)}
            </AsideLine>
          </>
        )}
      </AsideSection>
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
