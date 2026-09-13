// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Members tab: the users in it, then the agents it offers,
// each a card of rows. The agent row is the admin page's, without the
// form it opens there. Adding and removing wait for membership.

import { AgentRow } from "../../agents/AgentRow.tsx";
import type { Params } from "../../app/params.ts";
import { projectAgents } from "../../data/sessions.ts";
import { initials } from "../../lib/format.ts";
import { Frame } from "./Frame.tsx";

export function Members({ params }: { params: Params }) {
  const id = params.id ?? "";
  const agents = projectAgents.value;
  return (
    <Frame id={id} tab="members">
      {(shown) => (
        <>
          <section class="projects-card">
            <div class="projects-card-head">
              <span class="label">Users</span>
            </div>
            {shown.members.map((m) => (
              <div key={m.id} class="projects-member">
                <span class="projects-avatar">{initials(m.fullName)}</span>
                <span class="projects-member-name">{m.fullName}</span>
                <span class="projects-member-meta">@{m.username}</span>
              </div>
            ))}
          </section>
          <section class="projects-card">
            <div class="projects-card-head">
              <span class="label">Agents</span>
            </div>
            {agents === null ? (
              <p class="projects-card-state">Loading</p>
            ) : agents.length === 0 ? (
              <p class="projects-card-state">
                No agents yet. An admin adds one first.
              </p>
            ) : (
              agents.map((a) => (
                <div key={a.id} class="projects-agent">
                  <AgentRow agent={a} />
                </div>
              ))
            )}
          </section>
        </>
      )}
    </Frame>
  );
}
