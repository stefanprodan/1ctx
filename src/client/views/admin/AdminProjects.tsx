// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Team projects follow the users page's one-card shape. A collapsed row
// holds the tile, the name and, faint, the member count and since when,
// all from the list; opening it asks for the detail and draws the form
// in place.

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
import { Icon } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import { mark, metaLine } from "./AdminProjects.model.ts";
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
    <div
      class={`admin-projects-item${open ? " admin-projects-item-open" : ""}`}
    >
      <button
        type="button"
        class="admin-projects-row"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Icon
          name="chevron"
          size={14}
          class={`admin-projects-chevron${
            open ? " admin-projects-chevron-open" : ""
          }`}
        />
        <span
          class={`admin-projects-tile${open ? " admin-projects-tile-lit" : ""}`}
        >
          {mark(project.name)}
        </span>
        <span class="admin-projects-name">{project.name}</span>
        <span class="admin-projects-meta">{metaLine(project)}</span>
      </button>
      {open && (
        <div class="admin-projects-body">
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
        </div>
      )}
    </div>
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
      <div class="admin-projects">
        <section class="admin-projects-card">
          <div class="admin-projects-card-head">
            <span class="label">Projects</span>
            <button
              type="button"
              class="btn admin-projects-small admin-projects-card-act"
              disabled={adding.value}
              onClick={() => {
                adding.value = true;
                open.value = null;
              }}
            >
              <Icon name="plus" size={14} />
              New project
            </button>
          </div>
          {adding.value && (
            <div class="admin-projects-item admin-projects-item-open">
              <div class="admin-projects-body admin-projects-body-new">
                <ProjectForm
                  project={null}
                  users={users.value ?? []}
                  onDone={() => {
                    adding.value = false;
                  }}
                />
              </div>
            </div>
          )}
          {list?.length === 0 && !adding.value && (
            <p class="admin-projects-empty">No team projects yet.</p>
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
        </section>
      </div>
    </Page>
  );
}
