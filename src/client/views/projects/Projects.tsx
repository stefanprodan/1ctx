// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user's activity over up to a year, then their projects as one card of
// rows, the personal one first, each row leading to its project with
// its last two weeks on the chart's levels. An admin gets the link to
// where teams are made. The aside is Home's: the week and the agents.

import type { DaysUsageResponse } from "../../../shared/api/usage.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { AgentsAside } from "../../agents/AgentsAside.tsx";
import { me } from "../../data/me.ts";
import { projects, projectsError } from "../../data/projects.ts";
import { projectAgents } from "../../data/sessions.ts";
import { days } from "../../data/usage.ts";
import { Icon, projectIcon } from "../../lib/icons.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  Rows,
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsLink,
  RowsMeta,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Split } from "../../ui/Split.tsx";
import { WeekAside } from "../home/WeekAside.tsx";
import { activityModel } from "./Activity.model.ts";
import { Activity } from "./Activity.tsx";
import { peopleLine } from "./Project.model.ts";
import { Strip } from "./Strip.tsx";

function ProjectRow({
  project,
  answer,
  population,
}: {
  project: ProjectSummary;
  answer: DaysUsageResponse | null;
  population: readonly number[];
}) {
  return (
    <RowsGo href={`/projects/${project.id}`}>
      <RowsAvatar>
        <Icon name={projectIcon(project.kind)} size={14} />
      </RowsAvatar>
      <RowsTitle name={project.name} sub={peopleLine(project)} mono />
      {answer !== null && (
        <RowsMeta>
          <Strip
            answer={answer}
            projectId={project.id}
            population={population}
          />
        </RowsMeta>
      )}
    </RowsGo>
  );
}

export function Projects() {
  const list = projects.value;
  const ordered = [
    ...(list ?? []).filter((p) => p.kind === "personal"),
    ...(list ?? []).filter((p) => p.kind === "team"),
  ];
  const admin = me.value?.role === "admin";
  const answer = days.value;
  const model = answer === null ? null : activityModel(answer);
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
          {answer !== null && model !== null && (
            <Activity answer={answer} model={model} />
          )}
          <RowsCard
            label="Projects"
            action={
              admin ? (
                <RowsLink label="Manage" href="/admin/projects" />
              ) : undefined
            }
          >
            {ordered.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                answer={answer}
                population={model?.rowPopulation ?? []}
              />
            ))}
          </RowsCard>
        </Rows>
      </Split>
    </Page>
  );
}
