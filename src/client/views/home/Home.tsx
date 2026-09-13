// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home: the greeting, the composer that starts a chat in the personal
// project, the search, then every session the user may see as one
// stream. The query is the address; the route's load fetches the
// rows, and a clock moves the times without a fetch.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { navigate, query } from "../../app/router.ts";
import { Composer } from "../../composer/Composer.tsx";
import { me } from "../../data/me.ts";
import { projects } from "../../data/projects.ts";
import {
  createSession,
  list,
  projectAgents,
  sending,
} from "../../data/sessions.ts";
import { tickMs } from "../../stream/Row.model.ts";
import { Stream } from "../../stream/Stream.tsx";
import { Page } from "../../ui/Page.tsx";
import {
  dateLine,
  greeting,
  personalOf,
  searchHref,
  searchOf,
} from "./Home.model.ts";
import "./home.css";

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
  const personal = personalOf(projects.value);
  const q = searchOf(query.value);
  const projectName = (id: string) =>
    projects.value?.find((p) => p.id === id)?.name ?? null;
  return (
    <Page
      label={dateLine(new Date())}
      title={greeting(new Date(), user.fullName)}
    >
      <div class="home">
        {personal !== null && (
          <Composer
            scope={{ projectId: personal.id }}
            agents={projectAgents.value}
            agentId={null}
            running={false}
            busy={sending.value}
            onSend={async (message, agentId) => {
              await createSession({ projectId: personal.id, agentId, message });
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
          empty={
            q === "" ? "No chats yet. Start one above." : "Nothing matches."
          }
          now={now.value}
        />
      </div>
    </Page>
  );
}
