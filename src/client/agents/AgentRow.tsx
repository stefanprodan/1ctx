// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One agent as the parts of a row: the avatar, the name over the model
// id, and the faint meta with the model's window and prices, the
// provider OpenRouter tries first, the thinking level and the skill and
// MCP counts; a phone shows only the window and the price. The admin
// page puts them in the button that opens the form; the project's
// members tab in a line. They are the row's
// own parts, so a phone wraps them as it wraps a user's. The
// provider's name leads the meta when the caller knows it, since only
// an admin lists providers.

import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { RowsAvatar, RowsMeta, RowsTitle } from "../ui/Rows.tsx";
import {
  modelMeta,
  priceLine,
  serversLine,
  skillsLine,
  thinkingLine,
  windowLine,
} from "./meta.ts";

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
    agent.upstream === null ? "" : `via ${agent.upstream}`,
    thinkingLine(agent),
    skillsLine(agent),
    serversLine(agent),
  ]
    .filter((s) => s !== "")
    .join(" · ");
  // a phone shows the window and the price; the rest is in the open row
  const short = [
    windowLine(agent.model.contextLength),
    priceLine(agent.model.promptPrice, agent.model.completionPrice),
  ]
    .filter((s) => s !== "")
    .join(" · ");
  return (
    <>
      <RowsAvatar lit={lit}>
        <AvatarIcon name={agent.avatar} size={15} />
      </RowsAvatar>
      <RowsTitle name={agent.name} sub={agent.model.id} mono />
      <RowsMeta short={short}>{meta}</RowsMeta>
    </>
  );
}
