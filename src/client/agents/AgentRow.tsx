// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One agent as the parts of a row, the same in the Directory and on a
// project's Members tab: the avatar, the handle with the default tag,
// and the model id, its org dropped when it does not fit. The rest is
// on the agent's page the row leads to.

import type { Avatar } from "../../shared/words.ts";
import { AvatarIcon } from "../lib/avatars.tsx";
import { Fit } from "../ui/Fit.tsx";
import { RowsAvatar, RowsTag, RowsTitle } from "../ui/Rows.tsx";
import { shortModel } from "./meta.ts";
import "./agent-row.css";

export function AgentRow({
  agent,
}: {
  agent: { name: string; avatar: Avatar; model: string; default: boolean };
}) {
  return (
    <>
      <RowsAvatar>
        <AvatarIcon name={agent.avatar} size={15} />
      </RowsAvatar>
      <RowsTitle
        mono
        name={
          <>
            <span class="cut">@{agent.name}</span>
            {agent.default && <RowsTag>default</RowsTag>}
          </>
        }
        sub={
          <Fit
            class="agent-row-model cut"
            long={agent.model}
            short={shortModel(agent.model)}
          />
        }
      />
    </>
  );
}
