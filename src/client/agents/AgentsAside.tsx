// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agents a composer can pick, as an aside section: each its name
// over its model, the name leading to its page, and a link to manage
// them for an admin.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { agentHref } from "../lib/hrefs.ts";
import { Fit } from "../ui/Fit.tsx";
import { AsideSection } from "../ui/Split.tsx";
import { shortModel } from "./meta.ts";

export function AgentsAside({
  agents,
  admin,
}: {
  agents: AgentSummary[] | null;
  admin: boolean;
}) {
  return (
    <AsideSection
      label="Agents"
      action={
        admin ? (
          <a class="split-link" href="/admin/agents">
            Manage
          </a>
        ) : undefined
      }
    >
      {agents === null ? (
        <p class="split-empty">Loading</p>
      ) : agents.length === 0 ? (
        <p class="split-empty">No agents yet.</p>
      ) : (
        agents.map((a) => (
          <div key={a.id} class="split-line">
            <span class="avatar avatar-22">
              <AvatarIcon name={a.avatar} size={13} />
            </span>
            <span class="split-stack">
              <a class="split-name split-name-link" href={agentHref(a.name)}>
                {a.name}
              </a>
              <Fit
                class="split-faint"
                long={a.model.id}
                short={shortModel(a.model.id)}
              />
            </span>
          </div>
        ))
      )}
    </AsideSection>
  );
}
