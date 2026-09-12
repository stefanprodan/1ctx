// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One project: the name with what kind it is, the composer that starts
// a chat in it, its chats, then its members. Automations and knowledge
// land here with their areas.

import type { Params } from "../../app/params.ts";
import { Composer } from "../../composer/Composer.tsx";
import { project, projectError, projects } from "../../data/projects.ts";
import {
  createSession,
  projectAgents,
  projectSessions,
  sending,
} from "../../data/sessions.ts";
import { ago, initials } from "../../lib/format.ts";
import { Page } from "../../ui/Page.tsx";
import { kindText } from "./Project.model.ts";
import "./projects.css";

export function Project({ params }: { params: Params }) {
  const id = params.id ?? "";
  const row = project.value;
  const shown = row !== null && row.id === id ? row : null;
  // the name is in the rail's list before the page's row arrives
  const listed = projects.value?.find((p) => p.id === id);
  const now = Date.now();
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
            {projectSessions.value !== null &&
            projectSessions.value.length === 0 ? (
              <p class="projects-empty">No chats yet.</p>
            ) : (
              <ul class="projects-chats">
                {(projectSessions.value ?? []).map((s) => (
                  <li key={s.id}>
                    <a class="projects-chat" href={`/chat/${s.id}`}>
                      <span
                        class={`projects-dot projects-dot-${s.status}`}
                        title={s.status}
                      />
                      <span class="projects-chat-title">{s.title}</span>
                      <span class="projects-chat-when">
                        {ago(s.lastActivityAt, now)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
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
