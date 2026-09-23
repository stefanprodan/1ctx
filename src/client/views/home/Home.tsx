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
import { projects, projectsError } from "../../data/projects.ts";
import {
  createSession,
  homeProjectId,
  list,
  loadMore,
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
  emptyLine,
  greeting,
  originOf,
  searchHref,
  searchOf,
} from "./Home.model.ts";
import { WeekAside } from "./WeekAside.tsx";

export function Home() {
  const user = me.value!;
  const now = useSignal(Date.now());
  const held = list.value;
  const rows = held?.rows ?? null;
  const tick = tickMs(rows);
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, tick);
    return () => clearInterval(timer);
  }, [tick, now]);
  const target = composeProjectOf(projects.value, homeProjectId.value);
  const q = searchOf(query.value);
  const origin = originOf(query.value);
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
            onSend={async (message, agentId, uploads) => {
              await createSession({
                projectId: target.id,
                agentId,
                message,
                ...(uploads.length === 0 ? {} : { uploads }),
              });
            }}
            onStop={async () => {}}
          />
        )}
        {/* the feed waits for the list that places the composer above it
            and names each row's project, or it draws twice and jumps */}
        {(projects.value !== null || projectsError.value !== null) && (
          <Stream
            rows={rows}
            projectName={projectName}
            search={{
              value: q,
              onChange: (next) => navigate(searchHref("/", next, origin), true),
            }}
            filter={{
              value: origin,
              onPick: (next) => navigate(searchHref("/", q, next), true),
            }}
            empty={emptyLine(q, origin)}
            now={now.value}
            more={{
              next: (held?.next ?? null) !== null,
              loading: held?.more.loading ?? false,
              error: held?.more.error ?? null,
            }}
            onMore={() => void loadMore()}
          />
        )}
      </Split>
    </Page>
  );
}
