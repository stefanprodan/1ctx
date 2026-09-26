// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The user's activity over up to a year, then their projects as one card of
// rows, the personal one first, each row leading to its project with
// its last two weeks on the chart's levels. An admin gets the link to
// where teams are made. A search over the card narrows the rows by name,
// in place, since the list is the rail's and already loaded. The aside is
// Home's: the week and the agents.

import { useSignal } from "@preact/signals";
import type { DaysUsageResponse } from "../../../shared/api/usage.ts";
import type { ProjectSummary } from "../../../shared/contracts/project.ts";
import { AgentsAside } from "../../agents/AgentsAside.tsx";
import { me } from "../../data/me.ts";
import { projects, projectsError } from "../../data/projects.ts";
import { projectAgents } from "../../data/sessions.ts";
import { days, daysFailed } from "../../data/usage.ts";
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
import { Search } from "../../ui/Search.tsx";
import { Split } from "../../ui/Split.tsx";
import { WeekAside } from "../home/WeekAside.tsx";
import { activityModel } from "./Activity.model.ts";
import { Activity, ActivityGhost } from "./Activity.tsx";
import { listedProjects, peopleLine } from "./Project.model.ts";
import { Strip, StripGhost } from "./Strip.tsx";

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
      {answer !== null ? (
        <RowsMeta>
          <Strip
            answer={answer}
            projectId={project.id}
            population={population}
          />
        </RowsMeta>
      ) : (
        !daysFailed.value && (
          <RowsMeta>
            <StripGhost />
          </RowsMeta>
        )
      )}
    </RowsGo>
  );
}

export function Projects() {
  const list = projects.value;
  const q = useSignal("");
  const shown = listedProjects(list ?? [], q.value);
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
          {answer !== null && model !== null ? (
            <Activity answer={answer} model={model} />
          ) : (
            !daysFailed.value && <ActivityGhost />
          )}
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
              admin ? (
                <RowsLink label="Manage" href="/admin/projects" />
              ) : undefined
            }
          >
            {list !== null && shown.length === 0 && (
              <RowsNote>No projects found</RowsNote>
            )}
            {shown.map((p) => (
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
