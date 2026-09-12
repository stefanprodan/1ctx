// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One project: the name with what kind it is, then its members. Chats,
// automations and knowledge land here with their areas.

import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import {
  loadProject,
  project,
  projectError,
  projects,
} from "../../data/projects.ts";
import { initials } from "../../lib/format.ts";
import { Page } from "../../ui/Page.tsx";
import { kindText } from "./Project.model.ts";
import "./projects.css";

export function Project({ params }: { params: Params }) {
  const id = params.id ?? "";
  useEffect(() => {
    if (id !== "") void loadProject(id);
  }, [id]);
  const row = project.value;
  const shown = row !== null && row.id === id ? row : null;
  // the name is in the rail's list before the page's row arrives
  const listed = projects.value?.find((p) => p.id === id);
  return (
    <Page
      crumb="Projects"
      crumbHref="/projects"
      title={shown?.name ?? listed?.name ?? "Project"}
      loading={shown === null && projectError.value === null}
      error={projectError.value}
    >
      {shown && (
        <div class="projects-one">
          <p class="projects-kind-text">{kindText(shown.kind)}</p>
          <section class="projects-section">
            <h2 class="projects-section-title">Members</h2>
            <ul class="projects-members">
              {shown.members.map((m) => (
                <li key={m.id} class="projects-member">
                  <span class="projects-avatar">{initials(m.fullName)}</span>
                  <span class="projects-member-name">{m.fullName}</span>
                  <span class="projects-member-meta">@{m.username}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Page>
  );
}
