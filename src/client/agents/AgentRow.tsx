// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One agent as the parts of a row: the avatar, the name over the model
// id, and the faint meta with the model's window and prices and the
// thinking level. The admin page puts them in the button that opens
// the form; the project's members tab in a line. They are the row's
// own parts, so a phone wraps them as it wraps a user's. The
// provider's name leads the meta when the caller knows it, since only
// an admin lists providers.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { RowsAvatar, RowsMeta, RowsTitle } from "../ui/Rows.tsx";
import { modelMeta, skillsLine, thinkingLine } from "./meta.ts";

export function AgentRow({
  agent,
  providerName,
  lit,
}: {
  agent: AgentSummary;
  providerName?: string;
  // the avatar in the foreground, for the row that is open
  lit?: boolean;
}) {
  const meta = [
    providerName ?? "",
    modelMeta(agent.model),
    thinkingLine(agent),
    skillsLine(agent),
  ]
    .filter((s) => s !== "")
    .join(" · ");
  return (
    <>
      <RowsAvatar lit={lit}>
        <AvatarIcon name={agent.avatar} size={15} />
      </RowsAvatar>
      <RowsTitle name={agent.name} sub={agent.model.id} mono />
      <RowsMeta>{meta}</RowsMeta>
    </>
  );
}
