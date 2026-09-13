// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Team projects: a row each, the name over the member count and since
// when, all from the list. Opening a row loads the detail for its form.

import { useSignal } from "@preact/signals";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import {
  adminProject,
  adminProjectError,
  adminProjects,
  adminProjectsError,
  loadAdminProject,
} from "../../data/admin-projects.ts";
import { users, usersError } from "../../data/users.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAdd,
  RowsAvatar,
  RowsCard,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { countLine, mark, sinceLine } from "./AdminProjects.model.ts";
import { ProjectForm } from "./ProjectForm.tsx";
import "./admin-projects.css";

function ProjectRow({
  project,
  open,
  onToggle,
}: {
  project: ProjectSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const detail = adminProject.value;
  return (
    <RowsOpen
      open={open}
      onToggle={onToggle}
      head={
        <>
          <RowsAvatar lit={open}>{mark(project.name)}</RowsAvatar>
          <RowsTitle name={project.name} sub={countLine(project)} mono />
          <RowsMeta>{sinceLine(project)}</RowsMeta>
        </>
      }
    >
      {detail?.id === project.id ? (
        <ProjectForm
          project={detail}
          users={users.value ?? []}
          onDone={onToggle}
        />
      ) : adminProjectError.value !== null ? (
        <p class="admin-projects-note error">{adminProjectError.value}</p>
      ) : (
        <p class="admin-projects-note">Loading</p>
      )}
    </RowsOpen>
  );
}

export function AdminProjects() {
  const list = adminProjects.value;
  const open = useSignal<string | null>(null);
  const adding = useSignal(false);
  const error = adminProjectsError.value ?? usersError.value;
  return (
    <Page
      crumb="Admin"
      title="Projects"
      loading={(list === null || users.value === null) && error === null}
      error={error}
    >
      <Rows>
        <RowsCard
          label="Projects"
          action={
            <RowsAdd
              label="New project"
              disabled={adding.value}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            />
          }
        >
          {adding.value && (
            <RowsNew>
              <ProjectForm
                project={null}
                users={users.value ?? []}
                onDone={() => {
                  adding.value = false;
                }}
              />
            </RowsNew>
          )}
          {list?.length === 0 && !adding.value && (
            <RowsNote>No team projects yet.</RowsNote>
          )}
          {(list ?? []).map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              open={open.value === project.id}
              onToggle={() => {
                const next = open.value === project.id ? null : project.id;
                open.value = next;
                adding.value = false;
                if (next !== null) void loadAdminProject(next);
              }}
            />
          ))}
        </RowsCard>
      </Rows>
    </Page>
  );
}
