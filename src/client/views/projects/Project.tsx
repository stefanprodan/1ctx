// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One project: the name with what kind it is, the composer that starts
// a chat in it, its chats, then its members. Automations and knowledge
// land here with their areas.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { Params } from "../../app/params.ts";
import { Composer } from "../../composer/Composer.tsx";
import { project, projectError, projects } from "../../data/projects.ts";
import {
  createSession,
  list,
  projectAgents,
  sending,
} from "../../data/sessions.ts";
import { initials } from "../../lib/format.ts";
import { tickMs } from "../../stream/Row.model.ts";
import { Stream } from "../../stream/Stream.tsx";
import { Page } from "../../ui/Page.tsx";
import { kindText } from "./Project.model.ts";
import "./projects.css";

export function Project({ params }: { params: Params }) {
  const id = params.id ?? "";
  const row = project.value;
  const shown = row !== null && row.id === id ? row : null;
  // the name is in the rail's list before the page's row arrives
  const listed = projects.value?.find((p) => p.id === id);
  const rows = list.value;
  const now = useSignal(Date.now());
  const tick = tickMs(rows);
  useEffect(() => {
    const timer = setInterval(() => {
      now.value = Date.now();
    }, tick);
    return () => clearInterval(timer);
  }, [tick, now]);
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
          <Composer
            scope={{ projectId: shown.id }}
            agents={projectAgents.value}
            agentId={null}
            running={false}
            busy={sending.value}
            onSend={async (message, agentId) => {
              await createSession({ projectId: shown.id, agentId, message });
            }}
            onStop={async () => {}}
          />
          <section class="projects-section">
            <h2 class="projects-section-title">Chats</h2>
            <Stream
              rows={rows}
              projectName={() => null}
              empty="No chats yet."
              now={now.value}
            />
          </section>
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
