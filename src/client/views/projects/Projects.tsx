// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user's projects, one row each, the personal one first. Only the
// personal project exists so far, so the page is one row.

import { useEffect } from "preact/hooks";
import { loadProjects, projects, projectsError } from "../../data/projects.ts";
import { Icon } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import { kindLine } from "./Project.model.ts";
import "./projects.css";

export function Projects() {
  useEffect(() => {
    if (projects.value === null) void loadProjects();
  }, []);
  const list = projects.value;
  return (
    <Page
      crumb=""
      title="Projects"
      loading={list === null && projectsError.value === null}
      error={projectsError.value}
    >
      <div class="projects">
        {(list ?? []).map((p) => (
          <a key={p.id} class="projects-row" href={`/projects/${p.id}`}>
            <Icon name="projects" />
            <span class="projects-name">{p.name}</span>
            <span class="projects-kind">{kindLine(p.kind)}</span>
            <Icon name="chevron-right" size={14} class="projects-go" />
          </a>
        ))}
      </div>
    </Page>
  );
}
