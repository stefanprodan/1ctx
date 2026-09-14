// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home: the greeting, the composer that starts a chat in the project
// the user picks, the personal one at first, then every session the user may see as one stream, with
// the search in its head. At the right, the agents the composer can
// pick and what the week spent. The query is the address; the route's
// load fetches the rows, and a clock moves the times without a fetch.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { AgentsAside } from "../../agents/AgentsAside.tsx";
import { navigate, query } from "../../app/router.ts";
import { Composer } from "../../composer/Composer.tsx";
import { me } from "../../data/me.ts";
import { projects } from "../../data/projects.ts";
import {
  createSession,
  homeProjectId,
  list,
  pickHomeProject,
  projectAgents,
  sending,
} from "../../data/sessions.ts";
import { tickMs } from "../../stream/Row.model.ts";
import { Stream } from "../../stream/Stream.tsx";
import { Page } from "../../ui/Page.tsx";
import { Split } from "../../ui/Split.tsx";
import {
  composeProjectOf,
  dateLine,
  greeting,
  searchHref,
  searchOf,
} from "./Home.model.ts";
import { WeekAside } from "./WeekAside.tsx";

export function Home() {
  const user = me.value!;
  const now = useSignal(Date.now());
  const rows = list.value;
  const tick = tickMs(rows);
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, tick);
    return () => clearInterval(timer);
  }, [tick, now]);
  const target = composeProjectOf(projects.value, homeProjectId.value);
  const q = searchOf(query.value);
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
            onSend={async (message, agentId) => {
              await createSession({ projectId: target.id, agentId, message });
            }}
            onStop={async () => {}}
          />
        )}
        <Stream
          rows={rows}
          projectName={projectName}
          search={{
            value: q,
            onChange: (next) => navigate(searchHref("/", next), true),
          }}
          empty={q === "" ? "No sessions found" : "No sessions match"}
          now={now.value}
        />
      </Split>
    </Page>
  );
}
