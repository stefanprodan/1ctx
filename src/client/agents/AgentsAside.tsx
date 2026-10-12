// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { AGENTS_HREF, agentHref } from "../lib/hrefs.ts";
import { Fit } from "../ui/Fit.tsx";
import { AsideItem, AsideSection } from "../ui/Split.tsx";
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
          <a class="split-link" href={AGENTS_HREF}>
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
          <AsideItem
            key={a.id}
            name={a.name}
            href={agentHref(a.name)}
            lead={
              <span class="avatar avatar-22">
                <AvatarIcon name={a.avatar} size={13} />
              </span>
            }
            sub={
              <Fit
                class="cut"
                long={a.model.id}
                short={shortModel(a.model.id)}
              />
            }
          />
        ))
      )}
    </AsideSection>
  );
}
