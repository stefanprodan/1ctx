// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Team projects: a row each, the name over the member count and since
// when, all from the list. Opening a row loads the detail for its form.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { query } from "../../app/router.ts";
import {
  adminProject,
  adminProjectError,
  adminProjects,
  adminProjectsError,
  loadAdminProject,
} from "../../data/admin-projects.ts";
import { users, usersError } from "../../data/users.ts";
import { matches } from "../../lib/search.ts";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAdd,
  RowsCard,
  RowsMeta,
  RowsNew,
  RowsNote,
  RowsOpen,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Search } from "../../ui/Search.tsx";
import { countLine, sinceLine } from "./AdminProjects.model.ts";
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
      indent="chevron"
      head={
        <>
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
  const asked = new URLSearchParams(query.value).get("open");
  const open = useSignal(asked);
  // a Manage link followed while the page is up names another row
  useEffect(() => {
    if (asked !== null) open.value = asked;
  }, [asked, open]);
  const adding = useSignal(false);
  const error = adminProjectsError.value ?? usersError.value;
  const q = useSignal("");
  const shown = (list ?? []).filter((project) =>
    matches(q.value, [project.name]),
  );
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
          search={
            <Search
              value={q.value}
              onChange={(next) => {
                q.value = next;
              }}
              placeholder="Search projects"
            />
          }
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
          {q.value.trim() !== "" && shown.length === 0 && (
            <RowsNote>No projects found</RowsNote>
          )}
          {shown.map((project) => (
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
