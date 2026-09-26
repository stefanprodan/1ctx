// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home: the greeting, the composer that starts a chat in the project
// the user picks, the personal one at first, then every session the user may see as one stream, with
// the search in its head. At the right, the agents the composer can
// pick and what the week spent. The query is the address; the route's
// load fetches the rows, and a clock moves the times without a fetch.

import { AgentsAside } from "../../agents/AgentsAside.tsx";
import { Composer } from "../../composer/Composer.tsx";
import { me } from "../../data/me.ts";
import { projects, projectsError } from "../../data/projects.ts";
import {
  homeProjectId,
  pickHomeProject,
  projectAgents,
  sending,
} from "../../data/sessions.ts";
import { Page } from "../../ui/Page.tsx";
import { Split } from "../../ui/Split.tsx";
import { Feed, startChat } from "./Feed.tsx";
import { composeProjectOf, dateLine, greeting } from "./Home.model.ts";
import { WeekAside } from "./WeekAside.tsx";

export function Home() {
  const user = me.value!;
  const target = composeProjectOf(projects.value, homeProjectId.value);
  const projectName = (id: string) =>
    projects.value?.find((p) => p.id === id)?.name ?? null;
  const agents = projectAgents.value;
  return (
    <Page
      label={dateLine(new Date())}
      title={greeting(new Date(), user.fullName)}
    >
      <Split
        aside={
          <>
            <WeekAside />
            <AgentsAside agents={agents} admin={user.role === "admin"} />
          </>
        }
      >
        {target !== null && (
          <Composer
            scope={{ projectId: "home" }}
            filesProjectId={target.id}
            project={{
              projects: projects.value ?? [],
              projectId: target.id,
              onPick: (id) => void pickHomeProject(id),
            }}
            agents={agents}
            agentId={null}
            placeholder={`Send a message to ${target.name}`}
            running={false}
            busy={sending.value}
            onSend={startChat(target.id)}
            onStop={async () => {}}
          />
        )}
        {/* the feed waits for the list that places the composer above it
            and names each row's project, or it draws twice and jumps */}
        {(projects.value !== null || projectsError.value !== null) && (
          <Feed path="/" projectName={projectName} />
        )}
      </Split>
    </Page>
  );
}
