// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user's projects as two cards of rows: the personal one, then the
// team projects the user may see, each row leading to its project. An
// admin gets the link to where teams are made. The aside is Home's:
// the week and the agents.

import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { AgentsAside } from "../../agents/AgentsAside.tsx";
import { me } from "../../data/me.ts";
import { projects, projectsError } from "../../data/projects.ts";
import { projectAgents } from "../../data/sessions.ts";
import { Icon, projectIcon } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsLink,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Split } from "../../ui/Split.tsx";
import { WeekAside } from "../home/WeekAside.tsx";
import { peopleLine, sinceLine } from "./Project.model.ts";

function ProjectRow({ project }: { project: ProjectSummary }) {
  return (
    <RowsGo href={`/projects/${project.id}`}>
      <RowsAvatar>
        <Icon name={projectIcon(project.kind)} size={14} />
      </RowsAvatar>
      <RowsTitle name={project.name} sub={peopleLine(project)} mono />
      <RowsMeta>{sinceLine(project)}</RowsMeta>
    </RowsGo>
  );
}

export function Projects() {
  const list = projects.value;
  const personal = (list ?? []).filter((p) => p.kind === "personal");
  const teams = (list ?? []).filter((p) => p.kind === "team");
  const admin = me.value?.role === "admin";
  return (
    <Page
      crumb=""
      title="Projects"
      loading={list === null && projectsError.value === null}
      error={projectsError.value}
    >
      <Split
        aside={
          <>
            <WeekAside />
            <AgentsAside agents={projectAgents.value} admin={admin} />
          </>
        }
      >
        <Rows>
          <RowsCard label="Personal">
            {personal.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </RowsCard>
          <RowsCard
            label="Teams"
            action={
              admin ? (
                <RowsLink label="Manage" href="/admin/projects" />
              ) : undefined
            }
          >
            {teams.length === 0 && <RowsNote>No team projects yet</RowsNote>}
            {teams.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </RowsCard>
        </Rows>
      </Split>
    </Page>
  );
}
