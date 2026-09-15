// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Members tab: the users in it, then the agents it offers,
// each a card of rows. A personal project has one user, its owner, so
// it shows only the agents. An admin gets a link from each card to
// where it is managed. Every row leads to the user's or the agent's
// page.

import { AgentRow } from "../../agents/AgentRow.tsx";
import type { Params } from "../../app/params.ts";
import { me } from "../../data/me.ts";
import { projectAgents } from "../../data/sessions.ts";
import { initials } from "../../lib/format.ts";
import { agentHref, userHref } from "../../lib/hrefs.ts";
import {
  RowsAvatar,
  RowsCard,
  RowsGo,
  RowsLink,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Frame } from "./Frame.tsx";

export function Members({ params }: { params: Params }) {
  const id = params.id ?? "";
  const agents = projectAgents.value;
  const admin = me.value?.role === "admin";
  return (
    <Frame id={id} tab="members">
      {(shown) => (
        <>
          {shown.kind === "team" && (
            <RowsCard
              label="Users"
              action={
                admin && (
                  <RowsLink
                    label="Manage"
                    href={`/admin/projects?open=${encodeURIComponent(shown.id)}`}
                  />
                )
              }
            >
              {shown.members.length === 0 && (
                <RowsNote>No members yet.</RowsNote>
              )}
              {shown.members.map((m) => (
                <RowsGo key={m.id} href={userHref(m.username)}>
                  <RowsAvatar>{initials(m.fullName)}</RowsAvatar>
                  <RowsTitle name={m.fullName} sub={`@${m.username}`} />
                </RowsGo>
              ))}
            </RowsCard>
          )}
          <RowsCard
            label="Agents"
            action={admin && <RowsLink label="Manage" href="/admin/agents" />}
          >
            {agents === null ? (
              <RowsNote>Loading</RowsNote>
            ) : agents.length === 0 ? (
              <RowsNote>No agents yet. An admin adds one first.</RowsNote>
            ) : (
              agents.map((a) => (
                <RowsGo key={a.id} href={agentHref(a.name)}>
                  <AgentRow agent={a} />
                </RowsGo>
              ))
            )}
          </RowsCard>
        </>
      )}
    </Frame>
  );
}
