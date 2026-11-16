// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home: the greeting, the composer that starts a chat in the project
// the user picks, the personal one at first, the messages of the user's
// that were not sent, the external tasks that need a member, then every
// session the user may see as one
// feed, with the search in its head. At the right, the agents the
// composer can pick and what the week spent. The query is the address;
// the route's load fetches the rows, and a clock moves the times without
// a fetch.

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
import { useNow } from "../../lib/now.ts";
import { useWaiting } from "../../lib/wait.ts";
import { Page } from "../../ui/Page.tsx";
import { Split } from "../../ui/Split.tsx";
import { ComposerWaiting } from "./ComposerWaiting.tsx";
import { Feed, startChat } from "./Feed.tsx";
import { composeProjectOf, dateLine, greeting } from "./Home.model.ts";
import { NotSent } from "./NotSent.tsx";
import { WaitingTasks } from "./WaitingTasks.tsx";
import { WeekAside } from "./WeekAside.tsx";
import "./home.css";

export function Home() {
  const user = me.value!;
  const target = composeProjectOf(projects.value, homeProjectId.value);
  const projectName = (id: string) =>
    projects.value?.find((p) => p.id === id)?.name ?? null;
  const agents = projectAgents.value;
  const now = useNow(60_000);
  // held as Page holds its own, so a list landing just past the reveal
  // never flashes the bones away
  const listing = projects.value === null && projectsError.value === null;
  const wait = useWaiting(listing);
  return (
    <Page
      label={dateLine(new Date())}
      title={greeting(new Date(), user.fullName)}
      pending={listing}
    >
      <Split
        aside={
          <>
            <WeekAside />
            <AgentsAside agents={agents} admin={user.role === "admin"} />
          </>
        }
      >
        {wait && <ComposerWaiting label="Loading the composer" />}
        {!wait && target !== null && (
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
            placeholder={`Start a chat in ${target.name}`}
            running={false}
            busy={sending.value}
            onSend={startChat(target.id)}
            onStop={async () => {}}
          />
        )}
        <NotSent now={now} />
        <WaitingTasks now={now} />
        {/* the feed's rows wait for the list that names each row's
            project, or they draw twice and jump; its head is drawn */}
        <Feed path="/" projectName={projectName} waiting={wait} />
      </Split>
    </Page>
  );
}
