// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { RowsAvatar, RowsGo, RowsTitle } from "../ui/Rows.tsx";

export function AgentLinks({
  agents,
  href,
  sub,
}: {
  agents: readonly AgentSummary[];
  href: (agent: AgentSummary) => string;
  sub?: (agent: AgentSummary) => string | undefined;
}) {
  return (
    <>
      {agents.map((a) => (
        <RowsGo key={a.id} href={href(a)}>
          <RowsAvatar>
            <AvatarIcon name={a.avatar} size={15} />
          </RowsAvatar>
          <RowsTitle mono name={`@${a.name}`} sub={sub?.(a)} />
        </RowsGo>
      ))}
    </>
  );
}
