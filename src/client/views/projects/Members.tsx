// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's Members tab: the users in it, then the agents it offers,
// each a card of rows. A personal project has one user, its owner, so
// it shows only the agents. An admin gets a link from each card to
// where it is managed.

import { AgentRow } from "../../agents/AgentRow.tsx";
import type { Params } from "../../app/params.ts";
import { me } from "../../data/me.ts";
import { projectAgents } from "../../data/sessions.ts";
import { initials } from "../../lib/format.ts";
import {
  RowsAvatar,
  RowsCard,
  RowsLine,
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
                <RowsLine key={m.id} flush>
                  <RowsAvatar>{initials(m.fullName)}</RowsAvatar>
                  <RowsTitle name={m.fullName} sub={`@${m.username}`} />
                </RowsLine>
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
                <RowsLine key={a.id} flush>
                  <AgentRow agent={a} />
                </RowsLine>
              ))
            )}
          </RowsCard>
        </>
      )}
    </Frame>
  );
}
