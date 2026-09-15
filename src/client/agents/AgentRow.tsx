// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One agent as a row: the avatar, the name over the model id, and the
// faint meta line with the model's window and prices and the thinking
// level. The admin page wraps it in the button that opens the form;
// the project's members tab draws it bare. The provider's name leads
// the meta when the caller knows it, since only an admin lists
// providers.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { modelMeta, skillsLine, thinkingLine } from "./meta.ts";
import "./agent-row.css";

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
    <span class="agent-row">
      <span class={`agent-row-tile${lit ? " agent-row-tile-lit" : ""}`}>
        <AvatarIcon name={agent.avatar} size={15} />
      </span>
      <span class="agent-row-title">
        <span class="agent-row-name">{agent.name}</span>
        <span class="agent-row-model">{agent.model.id}</span>
      </span>
      <span class="agent-row-meta">{meta}</span>
    </span>
  );
}
